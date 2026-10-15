// ============================================
// طابور إنشاء الشحنات + التتبع الدوري لحالتها (ميزة الشحن التلقائي عبر dzship)
// هذا الملف هو الوحيد الذي يربط src/shipping.js (المعزولة تماماً عن D1/KV) بقاعدة البيانات والإشعارات.
// كل استدعاء فعلي لـdzship يمر عبر src/shipping.js فقط — هنا فقط منطق القراءة/الكتابة والقرار.
// ============================================

import { createShipmentForOrder, trackShipment, ShippingError, isShippingConfigured, TERMINAL_SHIPPING_STATUSES } from "./shipping.js";
import { decryptShippingCredentials } from "./security.js";
import { createNotification } from "./notifications.js";
import { WILAYA_NAME_TO_CODE } from "./orders.js";
import { resolveShipmentDestination } from "./shipping-desks.js";
import { getCourierShippingSupport } from "./shipping.js";

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// حد الشحنات: 5 لكل دورة كرون (كل دقيقتين) = 150/ساعة كحد أقصى نظري، تحت حد dzship المشترك (200/ساعة)
// بهامش أمان يفسح مجالاً لبقية استهلاك الموقع (لو استُخدمت dzship من مصدر آخر بنفس الوقت)
const QUEUE_BATCH_SIZE = 5;
const MAX_ATTEMPTS = 5;
// 502 = "رفضته شركة التوصيل" (بيانات خاطئة، بلدية غير معروفة...) وهو غالباً رفض دائم لا يتغيّر بالإعادة، فمحاولة إعادة واحدة تكفي
// بدل 5 (كل محاولة تستهلك من الحد المشترك لدى dzship وتؤخّر إبلاغ التاجر بالسبب الحقيقي)
const MAX_ATTEMPTS_COURIER_REJECTION = 2;
// طلب ظلّ أكثر من هذه المدة بالطابور بسبب رفض الحد المشترك (429) يُنهى بإشعار للتاجر ليشحنه يدوياً
const MAX_QUEUE_AGE_HOURS = 24;
const STUCK_PROCESSING_MINUTES = 10;

// حد التتبع: 30 شحنة لكل دورة (كل ربع ساعة) بتوازي 5 — أقل من حد dzship بالدقيقة (60)، ومجموعها اليومي 2880 من حدها (5000)
const TRACKING_BATCH_SIZE = 30;
const TRACKING_CONCURRENCY = 5;

// ============================================
// POST /api/vendor/orders/:id/create-shipment — طلب التاجر إنشاء شحنة (محمي + تحقق ملكية)
// لا يتصل بـdzship مباشرة أبداً: يُدخل الطلب في shipping_queue فقط، والمعالجة الفعلية بالكرون
// ============================================
// ---- قواعد مشتركة بين الإنشاء المفرد والجماعي (مصدر واحد للحقيقة) ----
const BULK_MAX_ORDERS = 25;                    // طلبات الدفعة الواحدة
const MAX_PENDING_SHIPMENTS_PER_VENDOR = 100;  // سقف ما يحجزه تاجر واحد بالطابور — لئلا يحتكر الحد المشترك لدى dzship (200/ساعة، 1000/يوم لكل الموقع)
const NOT_CONFIGURED_RESPONSE = () => jsonResponse({ error: "الشحن التلقائي غير مهيّأ على الخادم بعد — تواصل مع إدارة المنصة. الشحن اليدوي يعمل كالمعتاد", code: "SHIPPING_NOT_CONFIGURED" }, 503);

// هل يصلح هذا الطلب لإنشاء شحنة؟ null = نعم
function checkShipmentEligibility(order) {
    if (order.status === "cancelled") return { code: "ORDER_CANCELLED", message: "لا يمكن إنشاء شحنة لطلب ملغى" };
    if (order.tracking_number) return { code: "ALREADY_SHIPPED", message: "هذا الطلب له شحنة فعلية بالفعل", trackingNumber: order.tracking_number };
    return null;
}
// هل متجر التاجر جاهز للشحن التلقائي؟ null = نعم
function checkVendorShippingReady(vendor) {
    if (!vendor || vendor.shipping_mode !== "automatic") return { error: "الشحن التلقائي غير مفعّل لمتجرك — فعّله أولاً من إعدادات الشحن" };
    if (!vendor.courier) return { error: "اربط حساب شركة التوصيل أولاً من إعدادات الشحن" };
    return null;
}
const IN_LIST_SQL = (n) => Array.from({ length: n }, () => "?").join(",");
const VENDOR_SHIPPING_SQL = `SELECT v.shipping_mode, vsc.courier, vsc.credentials_encrypted
         FROM vendors v LEFT JOIN vendor_shipping_credentials vsc ON vsc.vendor_id = v.id WHERE v.id = ?`;

export async function handleCreateShipmentRequest(request, env, auth, orderId) {
    // بوابة الجاهزية أولاً: قبل أي قراءة D1 (الخادم غير مهيّأ = لا شحن تلقائي، والتاجر يشحن يدوياً كالمعتاد)
    if (!isShippingConfigured(env)) return NOT_CONFIGURED_RESPONSE();

    const order = await env.DB.prepare("SELECT id, status, tracking_number, delivery_type, wilaya, commune FROM orders WHERE id = ? AND vendor_id = ?")
        .bind(orderId, auth.vendor_id).first();
    if (!order) return jsonResponse({ error: "الطلب غير موجود أو لا تملك صلاحية الوصول إليه" }, 404);
    const ineligible = checkShipmentEligibility(order);
    if (ineligible) {
        return jsonResponse({ error: ineligible.message, code: ineligible.code, ...(ineligible.trackingNumber ? { trackingNumber: ineligible.trackingNumber } : {}) }, 409);
    }

    // وضع الشحن + الشركة المربوطة (وبيانات اعتمادها لجلب قائمة المكاتب عند الحاجة) باستعلام واحد
    const vendor = await env.DB.prepare(VENDOR_SHIPPING_SQL).bind(auth.vendor_id).first();
    const notReady = checkVendorShippingReady(vendor);
    if (notReady) return jsonResponse({ error: notReady.error }, 409);

    // هل تدعم شركة التاجر هذا النوع من التوصيل؟ وأي مكتب (للشركات التي تشترط معرّف مكتب)؟ — قبل أي إدخال بالطابور،
    // فلا يُهدر استدعاء مشترك لدى dzship على طلب سيُرفض حتماً، ويعرف التاجر السبب فوراً بدل بعد دقائق
    let body = null;
    try { body = await request.json(); } catch { /* الجسم اختياري: بلا مكتب محدد */ }
    const requestedDeskId = body && typeof body === "object" ? body.stop_desk_id : null;
    const destination = await resolveShipmentDestination(env, { order, vendor, requestedDeskId });
    if (destination.error) {
        return jsonResponse({ error: destination.error.message, code: destination.error.code }, destination.error.status);
    }

    try {
        await env.DB.prepare("INSERT INTO shipping_queue (order_id, vendor_id, stop_desk_id, stop_desk_commune) VALUES (?, ?, ?, ?)")
            .bind(orderId, auth.vendor_id, destination.stopDeskId, destination.stopDeskCommune).run();
    } catch {
        // الفهرس الفريد على order_id يرفض إدخالاً مكرراً (ضغط مزدوج على الزر، أو طلب سابق لا يزال بالطابور)
        // — نُعامله كنجاح، لا كخطأ، فالنتيجة العملية للمستخدم واحدة: طلبه بالفعل قيد المعالجة
        return jsonResponse({ message: "طلب إنشاء الشحنة قيد المعالجة بالفعل", alreadyQueued: true });
    }

    return jsonResponse({ message: "أُضيف الطلب لقائمة إنشاء الشحنات، ستظهر نتيجة الإنشاء خلال دقائق" }, 201);
}

// ---------------------------------------------
// POST /api/vendor/orders/bulk-create-shipments — إنشاء شحنات لعدة طلبات دفعة واحدة (حتى 25)
// جسم الطلب: { order_ids: [1, 2, ...] }. الرد 200 دائماً لطلب صالح، بنتيجة لكل طلب على حدة (queued | already_queued | failed)
// — فشل طلب واحد (ملغى، لا تدعمه الشركة، مكتب غير محدد...) لا يمنع بقية الدفعة.
//
// أرخص من 25 طلباً منفصلاً: قراءات D1 مجمَّعة (الطلبات باستعلام واحد، والتاجر وشركته مرة واحدة، وعدّ الطابور مرة واحدة) وكتابات الطابور
// بدفعة (batch) واحدة؛ وقوائم المكاتب تُجلب مرة لكل ولاية. الاختيار التلقائي للمكتب فقط (مكتب واحد ببلدية الزبون) — الغامض يُرفض
// بـSTOP_DESK_REQUIRED ليختاره التاجر من صفحة الطلب. وضغطة مزدوجة آمنة: INSERT OR IGNORE على الفهرس الفريد.
// ---------------------------------------------
export async function handleBulkCreateShipments(request, env, auth) {
    if (!isShippingConfigured(env)) return NOT_CONFIGURED_RESPONSE();

    let body = null;
    try { body = await request.json(); } catch { /* يُعامل كجسم غير صالح أدناه */ }
    const rawIds = body && Array.isArray(body.order_ids) ? body.order_ids : null;
    if (!rawIds || rawIds.length === 0) return jsonResponse({ error: "حدّد طلباً واحداً على الأقل" }, 400);
    const ids = [...new Set(rawIds)];
    if (ids.some(id => !Number.isInteger(id) || id <= 0)) return jsonResponse({ error: "معرّفات الطلبات غير صالحة" }, 400);
    if (ids.length > BULK_MAX_ORDERS) return jsonResponse({ error: `الحد الأقصى ${BULK_MAX_ORDERS} طلباً بالمرة الواحدة` }, 400);

    // ثلاثة استعلامات متوازية فقط، مهما بلغ عدد الطلبات
    const [{ results: orders }, vendor, pending] = await Promise.all([
        env.DB.prepare(
            `SELECT id, order_number, status, tracking_number, delivery_type, wilaya, commune FROM orders WHERE vendor_id = ? AND id IN (${IN_LIST_SQL(ids.length)})`
        ).bind(auth.vendor_id, ...ids).all(),
        env.DB.prepare(VENDOR_SHIPPING_SQL).bind(auth.vendor_id).first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM shipping_queue WHERE vendor_id = ?").bind(auth.vendor_id).first()
    ]);

    const notReady = checkVendorShippingReady(vendor);
    if (notReady) return jsonResponse({ error: notReady.error }, 409);
    if (pending.n >= MAX_PENDING_SHIPMENTS_PER_VENDOR) {
        return jsonResponse({
            error: `لديك ${pending.n} طلباً بانتظار إنشاء الشحنة بالفعل (الحد ${MAX_PENDING_SHIPMENTS_PER_VENDOR}) — انتظر اكتمالها ثم أعد المحاولة`,
            code: "QUEUE_FULL"
        }, 429);
    }

    const byId = new Map(orders.map(o => [o.id, o]));
    const deskMemo = new Map();
    const results = [];
    const toQueue = [];
    for (const id of ids) {
        const order = byId.get(id);
        if (!order) { results.push({ id, status: "failed", code: "ORDER_NOT_FOUND", error: "الطلب غير موجود أو لا تملك صلاحية الوصول إليه" }); continue; }
        const ineligible = checkShipmentEligibility(order);
        if (ineligible) { results.push({ id, order_number: order.order_number, status: "failed", code: ineligible.code, error: ineligible.message }); continue; }
        const destination = await resolveShipmentDestination(env, { order, vendor, requestedDeskId: null }, deskMemo);
        if (destination.error) { results.push({ id, order_number: order.order_number, status: "failed", code: destination.error.code, error: destination.error.message }); continue; }
        toQueue.push({ order, destination });
        results.push({ id, order_number: order.order_number, status: "pending" }); // يُحسم أدناه
    }

    if (toQueue.length > 0) {
        // كتابة واحدة بدفعة: الصف المكرر (طلب سبق إدخاله) يُتجاهل بلا خطأ، وchanges=0 يدلّ عليه
        const outcomes = await env.DB.batch(toQueue.map(({ order, destination }) =>
            env.DB.prepare("INSERT OR IGNORE INTO shipping_queue (order_id, vendor_id, stop_desk_id, stop_desk_commune) VALUES (?, ?, ?, ?)")
                .bind(order.id, auth.vendor_id, destination.stopDeskId, destination.stopDeskCommune)
        ));
        toQueue.forEach(({ order }, i) => {
            results.find(r => r.id === order.id).status = outcomes[i].meta.changes === 1 ? "queued" : "already_queued";
        });
    }

    const summary = { queued: 0, already_queued: 0, failed: 0 };
    results.forEach(r => { summary[r.status]++; });
    return jsonResponse({ summary, results });
}

// ============================================
// معالج الطابور — يُستدعى من الكرون كل دقيقتين (راجع wrangler.toml)
// ============================================
export async function processShippingQueue(env) {
    // الخادم غير مهيّأ (سر التشفير أو مساحة KV غائب): لا قراءة ولا كتابة ولا استدعاء — الدورة تنتهي فوراً بلا أي كلفة
    if (!isShippingConfigured(env)) return { skipped: "not_configured" };

    const reclaimed = await reclaimStuckProcessing(env);

    // استعلام واحد للمرشَّحين، ثم "قفل" كل صف على حدة قبل معالجته مباشرة بتحديث ذري (UPDATE ... WHERE status='pending').
    // القفل الذري يمنع تشغيلتي كرون متداخلتين من إنشاء شحنة مكررة لنفس الطلب. وقفل الصف قبيل معالجته (لا كل الدفعة مقدماً)
    // يعني أنه لو أوقفنا الدفعة مبكراً بسبب حد dzship تبقى بقية الصفوف 'pending' بلا أي كتابة إضافية، ولا تعلق بحالة processing
    const { results: candidates } = await env.DB.prepare(
        `SELECT id, order_id, attempts, stop_desk_id, stop_desk_commune, (julianday('now') - julianday(created_at)) * 24 AS age_hours
         FROM shipping_queue
         WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
         ORDER BY created_at ASC LIMIT ?`
    ).bind(QUEUE_BATCH_SIZE).all();

    let claimed = 0, succeeded = 0, retried = 0, failed = 0, paused = false;
    for (const row of candidates) {
        const lock = await env.DB.prepare(
            "UPDATE shipping_queue SET status = 'processing', claimed_at = datetime('now') WHERE id = ? AND status = 'pending'"
        ).bind(row.id).run();
        // changes === 0 يعني: سبقتنا إليه عملية أخرى (أو حُذف بالأثناء) — نتجاهله بأمان تام، لا خطأ
        if (lock.meta.changes !== 1) continue;
        claimed++;

        const outcome = await processQueueItem(env, row);
        if (outcome === "success") succeeded++;
        else if (outcome === "retry") retried++;
        else if (outcome === "paused") { paused = true; break; } // رفضت dzship بسبب الحد المشترك: لا جدوى من متابعة بقية الدفعة
        else failed++;
    }
    return { reclaimedStuck: reclaimed, claimed, succeeded, retried, failed, paused };
}

// صفوف عالقة بحالة "processing" منذ أكثر من 10 دقائق تعني انهيار الـWorker أثناء المعالجة (نادر لكن ممكن) —
// حالتها غامضة (قد تكون الشحنة أُنشئت فعلاً قبل الانهيار) فتُنهى بإشعار للتاجر، لا بإعادة محاولة آلية أبداً
async function reclaimStuckProcessing(env) {
    const { results } = await env.DB.prepare(
        `SELECT id, order_id FROM shipping_queue WHERE status = 'processing' AND claimed_at <= datetime('now', '-${STUCK_PROCESSING_MINUTES} minutes')`
    ).all();
    for (const row of results) {
        await finalizeAsAmbiguous(env, row.order_id, row.id,
            "توقفت معالجة إنشاء الشحنة بشكل غير متوقع منتصف العملية");
    }
    return results.length;
}

async function processQueueItem(env, queueRow) {
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(queueRow.order_id).first();
    if (!order || order.status === "cancelled" || order.tracking_number) {
        // الطلب اختفى منطقياً (أُلغي بالأثناء، أو له شحنة بالفعل من قبل) — لا داعي لأي استدعاء خارجي إطلاقاً
        await env.DB.prepare("DELETE FROM shipping_queue WHERE id = ?").bind(queueRow.id).run();
        return "skipped";
    }

    // استعلام واحد يجلب وضع الشحن وبيانات الاعتماد معاً — نفس نمط استعلام سعر التوصيل الحي بالمرحلة 3
    const vendor = await env.DB.prepare(
        `SELECT v.shipping_mode, vsc.courier, vsc.credentials_encrypted, vsc.from_wilaya
         FROM vendors v LEFT JOIN vendor_shipping_credentials vsc ON vsc.vendor_id = v.id WHERE v.id = ?`
    ).bind(order.vendor_id).first();

    if (!vendor || vendor.shipping_mode !== "automatic" || !vendor.courier || !vendor.credentials_encrypted) {
        // التاجر عطّل الوضع التلقائي أو ألغى الربط بعد إدخال هذا الطلب للطابور — لا معنى لإعادة المحاولة
        await finalizeAsFailed(env, order, queueRow.id, "أُلغي الإرسال التلقائي: الوضع التلقائي لم يعد مفعّلاً أو بيانات شركة التوصيل غير مكتملة");
        return "failed";
    }

    const credentials = await decryptShippingCredentials(vendor.credentials_encrypted, env.SHIPPING_ENCRYPTION_KEY);
    if (!credentials) {
        // فشل فك التشفير مُسجَّل بالفعل داخل security.js — لا نكرر التسجيل هنا
        await finalizeAsFailed(env, order, queueRow.id, "تعذّر قراءة بيانات اعتماد شركة التوصيل — أعد ربط حسابك من إعدادات الشحن");
        return "failed";
    }

    const wilayaCode = WILAYA_NAME_TO_CODE.get(order.wilaya);
    if (!wilayaCode) {
        await finalizeAsFailed(env, order, queueRow.id, `تعذّر التعرّف على الولاية "${order.wilaya}" بقوائم الشحن`);
        return "failed";
    }

    // دفاع أخير (لا يحدث بالمسار الطبيعي لأن التحقق يتم قبل الإدخال بالطابور): لو بدّل التاجر شركته بعد الإدخال، أو وُجد صف بلا مكتب لشركة
    // تشترطه، نُنهي الطلب بسبب واضح بلا أي استدعاء خارجي بدل أن تُرفض الشحنة لدى الشركة ويضيع من الحد المشترك
    const support = getCourierShippingSupport(vendor.courier);
    if (order.delivery_type === "office" && support.office === "unsupported") {
        await finalizeAsFailed(env, order, queueRow.id, "شركة التوصيل المربوطة لا تدعم التوصيل إلى المكتب عبر الربط الآلي — أنشئ الشحنة يدوياً من حسابك لدى الشركة");
        return "failed";
    }
    if (order.delivery_type !== "office" && !support.home) {
        await finalizeAsFailed(env, order, queueRow.id, "شركة التوصيل المربوطة تسلّم إلى نقاط الاستلام فقط ولا تدعم التوصيل للمنزل — أنشئ الشحنة يدوياً من حسابك لدى الشركة");
        return "failed";
    }
    if (order.delivery_type === "office" && support.office === "desk_id" && !queueRow.stop_desk_id) {
        await finalizeAsFailed(env, order, queueRow.id, "تعذّر تحديد مكتب الاستلام لهذا الطلب — أعد إنشاء الشحنة واختر المكتب");
        return "failed";
    }

    const { results: items } = await env.DB.prepare(
        "SELECT product_name, selected_attributes, quantity FROM order_items WHERE order_id = ?"
    ).bind(order.id).all();

    try {
        const options = Number.isInteger(vendor.from_wilaya) ? { fromWilaya: vendor.from_wilaya } : {};
        const result = await createShipmentForOrder({
            courier: vendor.courier, credentials, options, order, items, wilayaCode,
            stopDeskId: queueRow.stop_desk_id || null, stopDeskCommune: queueRow.stop_desk_commune || null
        });

        // تحديث الطلب وحذف صف الطابور بدفعة واحدة (batch) — إما ينجحان معاً أو لا يتغيّر شيء
        // status='shipped' تلقائياً: الطرد غادر المتجر فعلياً بمجرد وجود رقم تتبع حقيقي، لا داعي لتدخل التاجر يدوياً
        await env.DB.batch([
            env.DB.prepare(
                `UPDATE orders SET tracking_number = ?, label_url = ?, shipping_status = ?, shipping_courier = ?,
                        shipping_active = 1, status = 'shipped', updated_at = datetime('now') WHERE id = ?`
            ).bind(result.trackingNumber, result.labelUrl, result.status, vendor.courier, order.id),
            env.DB.prepare("DELETE FROM shipping_queue WHERE id = ?").bind(queueRow.id)
        ]);

        await createNotification(env, order.vendor_id, "shipment_created",
            `تم إنشاء شحنة للطلب ${order.order_number} — رقم التتبع: ${result.trackingNumber}`,
            `/vendor-order-detail.html?id=${order.id}`);
        return "success";
    } catch (err) {
        if (!(err instanceof ShippingError)) throw err; // خطأ برمجي غير متوقع — يظهر بسجلات الـWorker، لا نُخفيه بصمت

        if (err.ambiguous) {
            await finalizeAsAmbiguous(env, order.id, queueRow.id,
                `قد تكون الشحنة أُنشئت فعلاً عند ${vendor.courier} رغم هذا الخطأ (${err.message}) — تحقق من حساب الشركة قبل أي محاولة يدوية جديدة لتفادي شحنة مكررة`);
            return "failed";
        }

        // تجاوز الحد المسموح لدى dzship (429): رُفض الطلب قبل إنشاء أي شيء، فلا يُحتسب من محاولات هذا الطلب.
        // نُعيد الصف لحالة pending ونؤجّل كل الطابور المعلّق إلى ما بعد مهلة Retry-After (تحديث واحد لكل صف معلّق)،
        // فلا تُهدر دورات الكرون التالية على استدعاءات مرفوضة سلفاً. ويتوقف باقي دفعة هذه الدورة (outcome = paused)
        if (err.httpStatus === 429) {
            const waitSeconds = Math.min(Math.max(err.retryAfter || 60, 60), 3600);
            const waitModifier = `+${waitSeconds} seconds`;
            const pauseOthers = env.DB.prepare(
                `UPDATE shipping_queue SET next_attempt_at = datetime('now', ?)
                 WHERE status = 'pending' AND id != ? AND (next_attempt_at IS NULL OR next_attempt_at < datetime('now', ?))`
            ).bind(waitModifier, queueRow.id, waitModifier);

            if ((queueRow.age_hours || 0) > MAX_QUEUE_AGE_HOURS) {
                await env.DB.batch([env.DB.prepare("DELETE FROM shipping_queue WHERE id = ?").bind(queueRow.id), pauseOthers]);
                await createNotification(env, order.vendor_id, "shipment_failed",
                    `تعذّر إنشاء شحنة للطلب ${order.order_number}: بقيت شركة الخدمة ترفض الطلبات (حد الاستخدام المسموح) أكثر من ${MAX_QUEUE_AGE_HOURS} ساعة — أنشئ هذه الشحنة يدوياً`,
                    `/vendor-order-detail.html?id=${order.id}`);
            } else {
                await env.DB.batch([
                    env.DB.prepare(
                        "UPDATE shipping_queue SET status = 'pending', claimed_at = NULL, last_error = ?, next_attempt_at = datetime('now', ?) WHERE id = ?"
                    ).bind(err.message, waitModifier, queueRow.id),
                    pauseOthers
                ]);
            }
            return "paused";
        }

        const maxAttempts = err.httpStatus === 502 ? MAX_ATTEMPTS_COURIER_REJECTION : MAX_ATTEMPTS;
        if (!err.retryable || queueRow.attempts + 1 >= maxAttempts) {
            await finalizeAsFailed(env, order, queueRow.id, err.message);
            return "failed";
        }

        // فشل مؤقت وقابل للإعادة: تراجع تدريجي (30s ثم 60s ثم 90s...)، أو مهلة البوابة (Retry-After) أيهما أكبر
        const backoffSeconds = Math.max((queueRow.attempts + 1) * 30, err.retryAfter || 0);
        await env.DB.prepare(
            "UPDATE shipping_queue SET status = 'pending', attempts = attempts + 1, last_error = ?, next_attempt_at = datetime('now', ?) WHERE id = ?"
        ).bind(err.message, `+${backoffSeconds} seconds`, queueRow.id).run();
        return "retry";
    }
}

async function finalizeAsFailed(env, order, queueRowId, errorMessage) {
    await env.DB.prepare("DELETE FROM shipping_queue WHERE id = ?").bind(queueRowId).run();
    await createNotification(env, order.vendor_id, "shipment_failed",
        `تعذّر إنشاء شحنة للطلب ${order.order_number}: ${errorMessage}`,
        `/vendor-order-detail.html?id=${order.id}`);
}

// نسخة مستقلة تجلب بيانات الطلب بنفسها (تُستدعى من مسار الصفوف العالقة، حيث لا يتوفر صف order كاملاً بعد)
async function finalizeAsAmbiguous(env, orderId, queueRowId, message) {
    const order = await env.DB.prepare("SELECT vendor_id, order_number FROM orders WHERE id = ?").bind(orderId).first();
    await env.DB.prepare("DELETE FROM shipping_queue WHERE id = ?").bind(queueRowId).run();
    if (!order) return; // الطلب غير موجود فعلياً (لا يحدث بالتدفق الطبيعي؛ إجراء احترازي بحت)
    await createNotification(env, order.vendor_id, "shipment_failed", `${message} (الطلب ${order.order_number})`, `/vendor-order-detail.html?id=${orderId}`);
}

// ============================================
// التتبع الدوري — يُستدعى من الكرون مرة كل ربع ساعة (راجع src/scheduled.js و wrangler.toml)
//
// كلفة ثابتة مهما تراكمت الطلبات المنتهية، وعدالة بين كل الشحنات النشطة، بلا أي كتابة عند عدم تغيّر الحالة:
//  1) فحص معرّفات الشحنات النشطة فقط (shipping_active = 1) من فهرس جزئي تغطيه (covering): N مدخلاً من الفهرس، لا صفوف من الجدول.
//  2) كل دورة تفحص "نافذة" من 30 شحنة مرتّبة بالمعرّف: عدد النوافذ K = ceil(N/30)، ورقم نافذة هذه الدورة = (رقم ربع الساعة mod K).
//     رقم ربع الساعة يُحسب من وقت الجدولة نفسه (بلا أي حالة محفوظة: لا KV ولا كتابة D1)، فتمرّ كل شحنة بدورها كل K دورة.
//     النافذة الأخيرة تُثبَّت على حدّ القائمة فتبقى 30 دائماً (تداخل بسيط بدل نافذة ناقصة). اختبارها بمحاكاة تغيّر الشحنات
//     (إضافات/تسليمات/طفرات) أظهر: لا تجويع أبداً، وفجوة الفحص عند 99% من الحالات أقل من ضعفين ونصف المثالي.
//  3) جلب صفوف النافذة بمفاتيحها (30 صفاً) + بيانات اعتماد كل تاجر مرة واحدة (لا مرة لكل شحنة).
// ============================================

// أرقام النوافذ تُحسب من الوقت لا من عدّاد محفوظ؛ طول "الدورة" = ربع ساعة (يتطابق مع جدول التتبع بـ src/scheduled.js)
const TRACKING_SLOT_MS = 15 * 60 * 1000;

// دالة نقية (بلا قاعدة ولا شبكة) تختار نافذة هذه الدورة من معرّفات الشحنات النشطة المرتّبة تصاعدياً
export function pickTrackingWindow(sortedIds, slot, batchSize = TRACKING_BATCH_SIZE) {
    const total = sortedIds.length;
    if (total === 0) return { ids: [], total: 0, cycle: 0, windowIndex: 0 };
    const cycle = Math.ceil(total / batchSize);
    const windowIndex = ((slot % cycle) + cycle) % cycle;
    const start = Math.min(windowIndex * batchSize, Math.max(0, total - batchSize));
    return { ids: sortedIds.slice(start, start + batchSize), total, cycle, windowIndex };
}

const IN_LIST = (n) => Array.from({ length: n }, () => "?").join(",");

export async function processShippingTracking(env, scheduledTimeMs = Date.now()) {
    if (!isShippingConfigured(env)) return { skipped: "not_configured" };

    const summary = {
        active: 0, cycle: 0, window: 0, checked: 0, updated: 0, delivered: 0, returned: 0, lost: 0, cancelled: 0,
        unchanged: 0, skippedMismatch: 0, skippedError: 0, deactivated: 0, paused: false
    };

    // (1) معرّفات الشحنات النشطة فقط — فهرس جزئي يغطي الاستعلام (لا قراءة من جدول orders)
    const { results: idRows } = await env.DB.prepare("SELECT id FROM orders WHERE shipping_active = 1").all();
    const activeIds = idRows.map(r => r.id).sort((a, b) => a - b);

    // (2) نافذة هذه الدورة
    const win = pickTrackingWindow(activeIds, Math.floor(scheduledTimeMs / TRACKING_SLOT_MS));
    summary.active = win.total; summary.cycle = win.cycle; summary.window = win.windowIndex;
    if (win.ids.length === 0) return summary;

    // (3) صفوف النافذة (بمفاتيحها الأساسية) + بيانات اعتماد كل تاجر مرة واحدة
    const { results: rows } = await env.DB.prepare(
        `SELECT id, order_number, vendor_id, tracking_number, shipping_status, shipping_courier
         FROM orders WHERE shipping_active = 1 AND id IN (${IN_LIST(win.ids.length)})`
    ).bind(...win.ids).all();
    if (rows.length === 0) return summary;

    const vendorIds = [...new Set(rows.map(r => r.vendor_id))];
    const { results: credRows } = await env.DB.prepare(
        `SELECT vendor_id, courier, credentials_encrypted FROM vendor_shipping_credentials WHERE vendor_id IN (${IN_LIST(vendorIds.length)})`
    ).bind(...vendorIds).all();
    const vendorCreds = new Map(credRows.map(c => [c.vendor_id, c]));

    // تاجر فصل ربط شركته (بتأكيد صريح) وبقيت له شحنات نشطة: لا بيانات اعتماد لتتبعها أبداً. نُعطّلها بكتابة واحدة بدل أن
    // تشغل نوافذ التدوير إلى الأبد دون جدوى
    const orphans = rows.filter(r => !vendorCreds.has(r.vendor_id));
    if (orphans.length > 0) {
        await env.DB.prepare(`UPDATE orders SET shipping_active = 0 WHERE id IN (${IN_LIST(orphans.length)})`).bind(...orphans.map(o => o.id)).run();
        summary.deactivated = orphans.length;
    }
    const candidates = rows.filter(r => vendorCreds.has(r.vendor_id));

    const decryptedCache = new Map(); // vendor_id -> بيانات مفكوكة التشفير، لتفادي فك تشفير مكرر لنفس التاجر بالدفعة الواحدة
    for (let i = 0; i < candidates.length; i += TRACKING_CONCURRENCY) {
        const chunk = candidates.slice(i, i + TRACKING_CONCURRENCY);
        const results = await Promise.allSettled(chunk.map(row => trackOne(env, row, vendorCreds.get(row.vendor_id), decryptedCache)));
        let rateLimited = false;
        for (const r of results) {
            const outcome = r.status === "fulfilled" ? r.value : "error";
            summary.checked += outcome === "mismatch" ? 0 : 1;
            if (outcome === "rate_limited") { rateLimited = true; summary.skippedError++; }
            else if (outcome === "unchanged") summary.unchanged++;
            else if (outcome === "mismatch") summary.skippedMismatch++;
            else if (outcome === "error") summary.skippedError++;
            else { summary.updated++; if (outcome in summary) summary[outcome]++; } // updated | delivered | returned | lost | cancelled
        }
        // رفضت dzship بسبب الحد المشترك (429): لا جدوى من إرسال بقية الدفعة الآن، تُكمل الدورة التالية
        if (rateLimited) { summary.paused = true; break; }
    }
    return summary;
}

// رسائل إشعارات الحالات النهائية "غير السعيدة" (التسليم لا يحتاج إشعاراً: يظهر بحالة الطلب نفسها بلا كتابة إضافية)
const TERMINAL_NOTIFICATIONS = {
    returned: { type: "shipment_returned", text: (n) => `رجعت شحنة الطلب ${n} من الزبون — تحقق من السبب وتواصل معه إن أمكن` },
    lost: { type: "shipment_lost", text: (n) => `أبلغت شركة التوصيل بفقدان شحنة الطلب ${n} — تواصل معها لفتح تحقيق` },
    cancelled: { type: "shipment_cancelled", text: (n) => `ألغت شركة التوصيل شحنة الطلب ${n} — أنشئ شحنة جديدة أو تواصل مع الشركة` }
};

async function trackOne(env, row, vendorCred, decryptedCache) {
    // الشركة التي أنشأت الشحنة فعلياً يجب أن تطابق بيانات اعتماد التاجر الحالية — لو بدّل التاجر شركته
    // منذ إنشاء هذه الشحنة تحديداً، بيانات اعتماده الحالية لا تخص هذه الشحنة (وستُرفض حتماً لو استُخدمت،
    // مستهلكةً من الحد المشترك بلا أي فائدة). القيد الحقيقي (منع تبديل الشركة أثناء وجود شحنات نشطة) في vendor-shipping.js
    if (row.shipping_courier && row.shipping_courier !== vendorCred.courier) return "mismatch";

    let credentials = decryptedCache.get(row.vendor_id);
    if (credentials === undefined) {
        credentials = await decryptShippingCredentials(vendorCred.credentials_encrypted, env.SHIPPING_ENCRYPTION_KEY);
        decryptedCache.set(row.vendor_id, credentials);
    }
    if (!credentials) return "mismatch"; // فشل فك التشفير — ستُعاد المحاولة تلقائياً بدورتها القادمة، لا كتابة الآن

    let result;
    try {
        result = await trackShipment({ courier: vendorCred.courier, credentials, trackingNumber: row.tracking_number });
    } catch (err) {
        // 429 = الحد المشترك لدى dzship: يوقف باقي الدفعة. غيره (شبكة/خطأ مؤقت): تُعاد المحاولة تلقائياً بدورتها القادمة
        return err instanceof ShippingError && err.httpStatus === 429 ? "rate_limited" : "error";
    }

    // القاعدة الأهم: صفر كتابة لو الحالة الراجعة مطابقة تماماً للمخزَّنة أصلاً
    if (result.status === row.shipping_status) return "unchanged";

    // كتابة واحدة فقط تجمع كل شيء: حالة الشحنة، وإيقاف تتبعها لو وصلت لحالة نهائية، ونقل الطلب نفسه إلى "تم التسليم" عند وصولها
    // (فيدخل إيراد التاجر تلقائياً) — دون المساس بطلب ألغاه التاجر أو سُلّم أصلاً. الجملة لا تلمس أي عمود مفهرس عدا مدخل الفهرس الجزئي
    const terminal = TERMINAL_SHIPPING_STATUSES.includes(result.status);
    const delivered = result.status === "delivered";
    await env.DB.prepare(
        `UPDATE orders SET shipping_status = ?, shipping_active = ?,
                status = CASE WHEN ? = 1 AND status IN ('new', 'processing', 'shipped') THEN 'delivered' ELSE status END,
                updated_at = datetime('now')
         WHERE id = ? AND shipping_active = 1`
    ).bind(result.status, terminal ? 0 : 1, delivered ? 1 : 0, row.id).run();

    const notice = TERMINAL_NOTIFICATIONS[result.status];
    if (notice) {
        await createNotification(env, row.vendor_id, notice.type, notice.text(row.order_number), `/vendor-order-detail.html?id=${row.id}`);
        return result.status;
    }
    return delivered ? "delivered" : "updated";
}
