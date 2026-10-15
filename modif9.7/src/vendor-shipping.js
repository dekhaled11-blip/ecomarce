// ============================================
// إعدادات الشحن التلقائي للتاجر (ربط شركة توصيل عبر dzship، وضع يدوي/تلقائي)
// كل استدعاء فعلي لشركة التوصيل يمر عبر src/shipping.js فقط؛ هذا الملف مسؤول عن القراءة/الكتابة بـD1،
// التحقق من المدخلات، وحماية حالات التعارض (تبديل شركة أثناء شحنات نشطة، تفعيل تلقائي بلا بيانات اعتماد...)
// ============================================

import { listCouriers, getShippingRate, ShippingError, isShippingConfigured } from "./shipping.js";
import { encryptShippingCredentials } from "./security.js";

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// شرط SQL يُستخدم أكثر من مرة: شحنة "نشطة" = لها رقم تتبع ولم تصل بعد لحالة نهائية
// الشحنة النشطة = لم تصل بعد لحالة نهائية. عمود shipping_active يُضبط 1 عند إنشاء الشحنة ويعود 0 عند تسليمها/إرجاعها/إلغائها/فقدها،
// وله فهرس جزئي (vendor_id, id): عدّ شحنات تاجر معيّن يقرأ مدخلاتها هي فقط، لا كل طلباته القديمة
const ACTIVE_SHIPMENT_CONDITION = `shipping_active = 1`;

// ---------------------------------------------
// GET /api/vendor/shipping/couriers?q=... — قائمة شركات التوصيل المتاحة (محمي، لكن بلا أي قراءة D1 —
// بيانات مرجعية عامة فقط، مصدرها dzship نفسها ومكاش بحافة Cloudflare يوم كامل من src/shipping.js)
// ---------------------------------------------
export async function handleGetShippingCouriers(request, env, auth) {
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";

    try {
        const couriers = await listCouriers({ q });
        return jsonResponse({ couriers });
    } catch (err) {
        if (err instanceof ShippingError) {
            return jsonResponse({ error: "تعذّر جلب قائمة شركات التوصيل حالياً، حاول لاحقاً" }, 502);
        }
        throw err;
    }
}

// ---------------------------------------------
// GET /api/vendor/shipping/settings — وضع الشحن الحالي وبيانات الربط (بلا أي سر مطلقاً)
// قراءة D1 واحدة فقط
// ---------------------------------------------
export async function handleGetShippingSettings(request, env, auth) {
    const row = await env.DB.prepare(`
        SELECT v.shipping_mode, vsc.courier, vsc.from_wilaya, vsc.verified_at, vsc.updated_at
        FROM vendors v
        LEFT JOIN vendor_shipping_credentials vsc ON vsc.vendor_id = v.id
        WHERE v.id = ?
    `).bind(auth.vendor_id).first();

    if (!row) return jsonResponse({ error: "التاجر غير موجود" }, 404);

    // credentials_encrypted لا يُقرأ ولا يُرجَع هنا إطلاقاً — التأكيد الوحيد للتاجر هو "hasCredentials"
    return jsonResponse({
        shipping_mode: row.shipping_mode,
        courier: row.courier || null,
        from_wilaya: row.from_wilaya || null,
        hasCredentials: !!row.courier,
        serverConfigured: isShippingConfigured(env), // false = الشحن التلقائي مغلق على الخادم (لا ربط ولا تفعيل) حتى يُضبط السر والكاش
        verified_at: row.verified_at || null,
        updated_at: row.updated_at || null
    });
}

// ---------------------------------------------
// POST /api/vendor/shipping/settings — ربط/تحديث شركة التوصيل
// تحقق حي فعلي (استدعاء استعلام سعر خفيف) قبل أي حفظ — لا تُحفظ بيانات لم تُتحقَّق منها أبداً
// قراءة D1 واحدة (تجلب الشركة الحالية وعدد الشحنات النشطة معاً) + استدعاء خارجي واحد + كتابة D1 واحدة
// ---------------------------------------------
export async function handleSaveShippingSettings(request, env, auth) {
    // الربط يشفّر بيانات الاعتماد ويحتاج الكاش لاحقاً — لا يُسمح قبل تهيئة الخادم (لا قراءة D1 ولا استدعاء خارجي)
    if (!isShippingConfigured(env)) return jsonResponse({ error: "الشحن التلقائي غير مهيّأ على الخادم بعد — تواصل مع إدارة المنصة. الشحن اليدوي يعمل كالمعتاد", code: "SHIPPING_NOT_CONFIGURED" }, 503);

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const courier = typeof body.courier === "string" ? body.courier.trim() : "";
    if (!/^[a-z0-9_-]{2,40}$/.test(courier)) {
        return jsonResponse({ error: "شركة التوصيل المختارة غير صالحة" }, 400);
    }
    // sandbox مخصصة للاختبار الداخلي فقط (تُستخدم بالتطوير عبر courier="sandbox" بلا حساب حقيقي) —
    // لا يجوز ربطها كشركة فعلية بحساب تاجر حقيقي إطلاقاً، حتى لو وصلت كقيمة صالحة الشكل
    if (courier === "sandbox") {
        return jsonResponse({ error: "هذه الشركة مخصصة للاختبار الداخلي فقط ولا يمكن ربطها" }, 400);
    }

    // بيانات الاعتماد: 1-8 حقول نصية غير فارغة (نفس الحد الموثَّق لدى dzship). نُقلِّم القيم هنا قبل أي
    // استخدام أو تخزين — لا نعتمد على تقليم الشركة أو لاحقاً، فالفراغات الزائدة قد تُسبِّب رفضاً صامتاً
    const rawCredentials = body.credentials;
    const entries = rawCredentials && typeof rawCredentials === "object" && !Array.isArray(rawCredentials)
        ? Object.entries(rawCredentials) : [];
    const credentials = {};
    for (const [key, value] of entries) {
        if (typeof key !== "string" || typeof value !== "string") continue;
        const trimmed = value.trim();
        if (trimmed) credentials[key] = trimmed;
    }
    if (Object.keys(credentials).length < 1 || Object.keys(credentials).length > 8) {
        return jsonResponse({ error: "بيانات حساب شركة التوصيل غير مكتملة" }, 400);
    }

    // ولاية الانطلاق اختيارية عموماً، لكنها إجبارية فعلياً لدى Yalidine وعائلتها — لو أُغفلت مع شركة تحتاجها،
    // التحقق الحي أدناه سيفشل برسالة واضحة من dzship نفسها بدل تخمين قائمة الشركات التي تحتاجها بالكود هنا
    let fromWilaya = null;
    if (body.from_wilaya !== undefined && body.from_wilaya !== null && body.from_wilaya !== "") {
        const n = parseInt(body.from_wilaya, 10);
        if (!Number.isInteger(n) || n < 1 || n > 58) {
            return jsonResponse({ error: "ولاية الانطلاق غير صالحة" }, 400);
        }
        fromWilaya = n;
    }

    // استعلام واحد: الشركة المربوطة حالياً (إن وُجدت) + عدد الشحنات النشطة معاً، عبر استعلام فرعي بنفس القراءة
    const current = await env.DB.prepare(`
        SELECT vsc.courier as current_courier,
               (SELECT COUNT(*) FROM orders WHERE vendor_id = ? AND ${ACTIVE_SHIPMENT_CONDITION}) as active_shipments
        FROM vendors v
        LEFT JOIN vendor_shipping_credentials vsc ON vsc.vendor_id = v.id
        WHERE v.id = ?
    `).bind(auth.vendor_id, auth.vendor_id).first();

    if (!current) return jsonResponse({ error: "التاجر غير موجود" }, 404);

    // تبديل الشركة (لا مجرد تحديث بيانات نفس الشركة) أثناء وجود شحنات نشطة يقطع تتبعها فوراً —
    // بيانات الاعتماد الجديدة لا تخص تلك الشحنات القديمة إطلاقاً (أُنشئت فعلياً عند الشركة السابقة)
    if (current.current_courier && current.current_courier !== courier && current.active_shipments > 0) {
        return jsonResponse({
            error: `لا يمكن تبديل شركة التوصيل الآن — لديك ${current.active_shipments} شحنة نشطة عند الشركة الحالية، انتظر اكتمالها أولاً`,
            activeShipments: current.active_shipments
        }, 409);
    }

    // التحقق الحي: استعلام سعر خفيف (لا يُنشئ أي شحنة فعلية) يتحقق من صحة بيانات الاعتماد فعلياً قبل الحفظ
    // — نستخدم ولاية الانطلاق نفسها كوجهة افتراضية لو حُدِّدت (منطقية الطلب)، وإلا الجزائر العاصمة (16، متاحة دوماً)
    try {
        await getShippingRate({
            courier, credentials,
            options: fromWilaya ? { fromWilaya } : {},
            toWilaya: fromWilaya || 16,
            deliveryType: "home"
        });
    } catch (err) {
        if (err instanceof ShippingError) {
            return jsonResponse({ error: `تعذّر التحقق من بيانات الحساب: ${err.message}` }, 400);
        }
        throw err;
    }

    const credentialsEncrypted = await encryptShippingCredentials(credentials, env.SHIPPING_ENCRYPTION_KEY);

    await env.DB.prepare(`
        INSERT INTO vendor_shipping_credentials (vendor_id, courier, credentials_encrypted, from_wilaya, verified_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(vendor_id) DO UPDATE SET
            courier = excluded.courier,
            credentials_encrypted = excluded.credentials_encrypted,
            from_wilaya = excluded.from_wilaya,
            verified_at = excluded.verified_at,
            updated_at = excluded.updated_at
    `).bind(auth.vendor_id, courier, credentialsEncrypted, fromWilaya).run();

    return jsonResponse({ message: "تم التحقق من الحساب وربطه بنجاح", courier, from_wilaya: fromWilaya });
}

// ---------------------------------------------
// POST /api/vendor/shipping/mode — تبديل يدوي/تلقائي
// قراءة D1 واحدة + كتابة D1 واحدة
// ---------------------------------------------
export async function handleSetShippingMode(request, env, auth) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const mode = body.mode;
    if (mode !== "manual" && mode !== "automatic") {
        return jsonResponse({ error: "وضع شحن غير صالح" }, 400);
    }

    // العودة للوضع اليدوي مسموحة دائماً (أمان)، أما التفعيل التلقائي فلا قبل تهيئة الخادم
    if (mode === "automatic" && !isShippingConfigured(env)) return jsonResponse({ error: "الشحن التلقائي غير مهيّأ على الخادم بعد — تواصل مع إدارة المنصة. الشحن اليدوي يعمل كالمعتاد", code: "SHIPPING_NOT_CONFIGURED" }, 503);

    if (mode === "automatic") {
        const creds = await env.DB.prepare("SELECT 1 FROM vendor_shipping_credentials WHERE vendor_id = ?")
            .bind(auth.vendor_id).first();
        if (!creds) {
            return jsonResponse({ error: "اربط شركة توصيل أولاً من إعدادات الشحن قبل تفعيل الوضع التلقائي" }, 409);
        }
    }

    await env.DB.prepare("UPDATE vendors SET shipping_mode = ? WHERE id = ?").bind(mode, auth.vendor_id).run();
    return jsonResponse({ message: mode === "automatic" ? "تم تفعيل الشحن التلقائي" : "تم التحويل للشحن اليدوي", shipping_mode: mode });
}

// ---------------------------------------------
// DELETE /api/vendor/shipping/credentials — فصل الربط بشركة التوصيل
// يتطلب تأكيداً صريحاً (force) لو توجد شحنات نشطة — نفس نمط تأكيد إلغاء الطلب بـorders.js
// قراءة D1 واحدة + حتى كتابتين (حذف الربط، وإرجاع الوضع ليدوي تلقائياً لو كان تلقائياً)
// ---------------------------------------------
export async function handleUnlinkShippingCredentials(request, env, auth) {
    let body = {};
    try {
        body = await request.json();
    } catch {
        // جسم الطلب اختياري هنا (DELETE بلا force = الحالة الافتراضية)؛ عدم وجوده ليس خطأً
    }

    const current = await env.DB.prepare(`
        SELECT v.shipping_mode,
               (SELECT COUNT(*) FROM orders WHERE vendor_id = ? AND ${ACTIVE_SHIPMENT_CONDITION}) as active_shipments
        FROM vendors v WHERE v.id = ?
    `).bind(auth.vendor_id, auth.vendor_id).first();

    if (!current) return jsonResponse({ error: "التاجر غير موجود" }, 404);

    if (current.active_shipments > 0 && !body.force) {
        return jsonResponse({
            error: `لديك ${current.active_shipments} شحنة نشطة حالياً — فصل الربط سيوقف تتبعها تلقائياً بموقعنا (تبقى قائمة فعلياً عند الشركة نفسها)`,
            requiresConfirmation: true,
            activeShipments: current.active_shipments
        }, 409);
    }

    const statements = [env.DB.prepare("DELETE FROM vendor_shipping_credentials WHERE vendor_id = ?").bind(auth.vendor_id)];
    // لا يجوز أن يبقى التاجر بوضع "تلقائي" بلا بيانات اعتماد — إرجاع تلقائي وواضح للوضع اليدوي
    if (current.shipping_mode === "automatic") {
        statements.push(env.DB.prepare("UPDATE vendors SET shipping_mode = 'manual' WHERE id = ?").bind(auth.vendor_id));
    }
    await env.DB.batch(statements);

    return jsonResponse({ message: "تم فصل الربط بشركة التوصيل، وعاد متجرك للوضع اليدوي" });
}
