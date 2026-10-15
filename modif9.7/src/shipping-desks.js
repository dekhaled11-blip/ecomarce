// ============================================
// مكاتب الاستلام (stopdesk) للشحن التلقائي — الوصل بين src/shipping.js (المعزولة عن D1/KV) والكاش وقاعدة البيانات.
//
// ما يفعله هذا الملف:
//   1) كاش KV لقوائم المكاتب لكل (شركة، ولاية) يوماً كاملاً — توصية وثيقة dzship نفسها ("Cache the answer per courier and wilaya
//      for a day")، وحدّها 60 استدعاء/دقيقة لكل IP. الفشل يُخزَّن 60 ثانية فقط حتى لا تُكرَّر استدعاءات فاشلة أثناء عطل.
//   2) GET /api/vendor/orders/:id/stop-desks — قائمة مكاتب ولاية الطلب مرتّبة (مكاتب بلدية الزبون أولاً) مع اقتراح لو وُجد
//      مكتب واحد بالضبط ببلدية الزبون. يُستدعى كسولاً فقط حين يفتح التاجر نافذة إنشاء الشحنة لطلب مكتب بشركة تشترط معرّف مكتب.
//   3) resolveShipmentDestination: القرار الموحّد عند إنشاء الشحنة — هل يُدعم هذا النوع من التوصيل بشركة التاجر؟ وأي مكتب يُستعمل؟
// ============================================

import { listStopDesks, resolveCommuneFr, rankDesksForCommune, getCourierShippingSupport, ShippingError, isShippingConfigured } from "./shipping.js";
import { decryptShippingCredentials } from "./security.js";
import { WILAYA_NAME_TO_CODE } from "./orders.js";

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const DESK_CACHE_TTL_SECONDS = 86400;  // يوم كامل لكل (شركة، ولاية)
const DESK_FAILURE_TTL_SECONDS = 60;   // فشل جلب القائمة: لا نعيد الاستدعاء قبل دقيقة (حد dzship للمكاتب 60/دقيقة لكل IP)

const MESSAGES = {
    HOME_NOT_SUPPORTED: "شركة التوصيل المربوطة تسلّم إلى نقاط الاستلام فقط ولا تدعم التوصيل للمنزل عبر الربط الآلي — أنشئ شحنة هذا الطلب يدوياً من حسابك لدى الشركة",
    OFFICE_NOT_SUPPORTED: "شركة التوصيل المربوطة لا تدعم التوصيل إلى المكتب عبر الربط الآلي — أنشئ شحنة هذا الطلب يدوياً من حسابك لدى الشركة",
    STOP_DESK_REQUIRED: "اختر مكتب الاستلام الذي سيستلم منه الزبون طرده",
    STOP_DESK_INVALID: "المكتب المختار غير موجود بقائمة مكاتب ولاية الزبون لدى الشركة — اختر مكتباً من القائمة",
    NO_STOP_DESKS: "لا توجد مكاتب استلام لدى هذه الشركة بولاية الزبون — أنشئ شحنة هذا الطلب يدوياً من حسابك لدى الشركة"
};

// قائمة مكاتب ولاية لشركة، من الكاش أولاً (قراءة KV واحدة) ثم من dzship عند الفراغ فقط (استدعاء واحد + كتابة KV واحدة).
// الأخطاء تصعد كـShippingError بعربية جاهزة؛ والكاش/KV نفسه لا يُسقط العملية أبداً (فشل KV = نكمل بلا كاش)
export async function getStopDesksCached(env, { courier, credentialsEncrypted, wilayaCode }) {
    const key = `desks:${courier}:${wilayaCode}`;
    try {
        const hit = await env.SHIPPING_CACHE_KV.get(key, "json");
        if (hit && Array.isArray(hit.desks)) return hit.desks;
        if (hit && hit.failed) throw new ShippingError("DESK_LIST_UNAVAILABLE", hit.message || null);
    } catch (err) {
        if (err instanceof ShippingError) throw err;
        // خلل بقراءة KV: نتجاوز الكاش ونكمل
    }

    const credentials = await decryptShippingCredentials(credentialsEncrypted, env.SHIPPING_ENCRYPTION_KEY);
    if (!credentials) throw new ShippingError("MISSING_CREDENTIALS", "تعذّر قراءة بيانات اعتماد شركة التوصيل — أعد ربط حسابك من إعدادات الشحن");

    let desks;
    try {
        desks = await listStopDesks({ courier, credentials, wilayaCode });
    } catch (err) {
        try {
            await env.SHIPPING_CACHE_KV.put(key, JSON.stringify({ failed: true, message: err instanceof ShippingError ? err.message : null }), { expirationTtl: DESK_FAILURE_TTL_SECONDS });
        } catch { /* لا يهم */ }
        throw err;
    }
    try {
        await env.SHIPPING_CACHE_KV.put(key, JSON.stringify({ desks }), { expirationTtl: DESK_CACHE_TTL_SECONDS });
    } catch { /* لا يهم */ }
    return desks;
}

// بلدية الزبون بالفرنسية من قائمة dzship (لاقتراح المكتب فقط): فشل المطابقة ليس خطأً هنا، فقط لا اقتراح
async function communeFrOrNull(wilayaCode, communeName) {
    try {
        return await resolveCommuneFr(wilayaCode, communeName);
    } catch {
        return null;
    }
}

// قائمة مكاتب بذاكرة طلب واحد اختيارية (Map): بالإنشاء الجماعي تُجلب قائمة كل ولاية مرة واحدة فقط (قراءة KV واحدة، وربما
// استدعاء dzship واحد) مهما تعدّدت طلبات الدفعة بنفس الولاية — نجاحاً أو فشلاً
async function desksForWilaya(env, args, memo) {
    if (!memo) return getStopDesksCached(env, args);
    const key = `${args.courier}:${args.wilayaCode}`;
    if (!memo.has(key)) memo.set(key, getStopDesksCached(env, args).then(value => ({ value }), error => ({ error })));
    const outcome = await memo.get(key);
    if (outcome.error) throw outcome.error;
    return outcome.value;
}

// ---- القرار عند إنشاء الشحنة ----
// يُرجع { stopDeskId, stopDeskCommune } (null بكليهما إن لم يلزم مكتب محدد) أو { error: { status, code, message } }
export async function resolveShipmentDestination(env, { order, vendor, requestedDeskId }, deskMemo = null) {
    const support = getCourierShippingSupport(vendor.courier);
    const none = { stopDeskId: null, stopDeskCommune: null };
    const fail = (status, code, message) => ({ error: { status, code, message } });

    if (order.delivery_type !== "office") {
        return support.home ? none : fail(409, "HOME_NOT_SUPPORTED", MESSAGES.HOME_NOT_SUPPORTED);
    }
    if (support.office === "unsupported") return fail(409, "OFFICE_NOT_SUPPORTED", MESSAGES.OFFICE_NOT_SUPPORTED);
    if (support.office === "commune") return none; // الشركة توجّه الطرد لمكتب بلدية الزبون بنفسها

    // desk_id: لا بد من معرّف مكتب صالح بقائمة ولاية الزبون
    const wilayaCode = WILAYA_NAME_TO_CODE.get(order.wilaya);
    if (!wilayaCode) return fail(409, "LOCAL_VALIDATION", `تعذّر التعرّف على الولاية "${order.wilaya}" بقوائم الشحن`);

    let desks;
    try {
        desks = await desksForWilaya(env, { courier: vendor.courier, credentialsEncrypted: vendor.credentials_encrypted, wilayaCode }, deskMemo);
    } catch (err) {
        if (!(err instanceof ShippingError)) throw err;
        return fail(503, "DESK_LIST_UNAVAILABLE", err.message);
    }
    if (desks.length === 0) return fail(409, "NO_STOP_DESKS", MESSAGES.NO_STOP_DESKS);

    let chosen = null;
    if (typeof requestedDeskId === "string" && requestedDeskId.trim() !== "") {
        chosen = desks.find(d => d.id === requestedDeskId.trim()) || null;
        if (!chosen) return fail(409, "STOP_DESK_INVALID", MESSAGES.STOP_DESK_INVALID);
    } else {
        // لم يُحدَّد مكتب (مثلاً إنشاء جماعي): نختار تلقائياً فقط لو يوجد مكتب واحد بالضبط ببلدية الزبون — غير ذلك لا نخمّن
        const ranked = rankDesksForCommune(desks, await communeFrOrNull(wilayaCode, order.commune));
        chosen = ranked.suggestedId ? desks.find(d => d.id === ranked.suggestedId) : null;
        if (!chosen) return fail(409, "STOP_DESK_REQUIRED", MESSAGES.STOP_DESK_REQUIRED);
    }
    return { stopDeskId: chosen.id, stopDeskCommune: chosen.communeName || null };
}

// ---------------------------------------------
// GET /api/vendor/orders/:id/stop-desks — قائمة مكاتب ولاية الطلب لنافذة إنشاء الشحنة (محمي + تحقق ملكية)
// استعلام D1 واحد (JOIN) + قراءة KV واحدة؛ استدعاء dzship فقط عند فراغ الكاش
// ---------------------------------------------
export async function handleListOrderStopDesks(request, env, auth, orderId) {
    if (!isShippingConfigured(env)) {
        return jsonResponse({ error: "الشحن التلقائي غير مهيّأ على الخادم بعد — تواصل مع إدارة المنصة. الشحن اليدوي يعمل كالمعتاد", code: "SHIPPING_NOT_CONFIGURED" }, 503);
    }
    const row = await env.DB.prepare(
        `SELECT o.id, o.status, o.tracking_number, o.delivery_type, o.wilaya, o.commune,
                v.shipping_mode, vsc.courier, vsc.credentials_encrypted
         FROM orders o JOIN vendors v ON v.id = o.vendor_id
         LEFT JOIN vendor_shipping_credentials vsc ON vsc.vendor_id = o.vendor_id
         WHERE o.id = ? AND o.vendor_id = ?`
    ).bind(orderId, auth.vendor_id).first();
    if (!row) return jsonResponse({ error: "الطلب غير موجود أو لا تملك صلاحية الوصول إليه" }, 404);
    if (row.shipping_mode !== "automatic" || !row.courier) return jsonResponse({ error: "الشحن التلقائي غير مفعّل لمتجرك" }, 409);
    if (row.tracking_number) return jsonResponse({ error: "هذا الطلب له شحنة فعلية بالفعل" }, 409);

    if (row.delivery_type !== "office") return jsonResponse({ mode: "not_needed", desks: [], suggestedId: null });
    const support = getCourierShippingSupport(row.courier);
    if (support.office !== "desk_id") return jsonResponse({ mode: support.office, desks: [], suggestedId: null });

    const wilayaCode = WILAYA_NAME_TO_CODE.get(row.wilaya);
    if (!wilayaCode) return jsonResponse({ error: `تعذّر التعرّف على الولاية "${row.wilaya}" بقوائم الشحن` }, 409);

    let desks;
    try {
        desks = await getStopDesksCached(env, { courier: row.courier, credentialsEncrypted: row.credentials_encrypted, wilayaCode });
    } catch (err) {
        if (!(err instanceof ShippingError)) throw err;
        return jsonResponse({ error: err.message, code: "DESK_LIST_UNAVAILABLE" }, 503);
    }
    const ranked = rankDesksForCommune(desks, await communeFrOrNull(wilayaCode, row.commune));
    return jsonResponse({ mode: "desk_id", desks: ranked.desks, suggestedId: ranked.suggestedId });
}
