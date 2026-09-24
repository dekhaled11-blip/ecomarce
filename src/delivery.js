// ============================================
// وحدة أسعار التوصيل لكل تاجر (افتراضي عام + استثناءات اختيارية لكل ولاية)
// ============================================

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

const WILAYA_CODE_REGEX = /^\d{2}$/;

// ---------------------------------------------
// GET /api/vendor/delivery-rates — الأسعار الافتراضية + كل الاستثناءات المخصَّصة (محمي)
// استعلامان بالحد الأقصى فقط، بالتوازي — يُستدعى نادراً (فتح صفحة الإعدادات فقط، مو كل زيارة)
// ---------------------------------------------
export async function handleGetDeliveryRates(request, env, auth) {
    const [vendor, ratesResult] = await Promise.all([
        env.DB.prepare(
            "SELECT default_home_delivery_fee, default_office_delivery_fee FROM vendors WHERE id = ?"
        ).bind(auth.vendor_id).first(),
        env.DB.prepare(
            "SELECT wilaya_code, home_price, office_price FROM vendor_delivery_rates WHERE vendor_id = ? ORDER BY wilaya_code"
        ).bind(auth.vendor_id).all()
    ]);

    if (!vendor) return jsonResponse({ error: "التاجر غير موجود" }, 404);

    return jsonResponse({
        default_home_delivery_fee: vendor.default_home_delivery_fee,
        default_office_delivery_fee: vendor.default_office_delivery_fee,
        exceptions: ratesResult.results
    });
}

// ---------------------------------------------
// PUT /api/vendor/delivery-rates — تحديث الأسعار الافتراضية واستبدال كل الاستثناءات دفعة واحدة (محمي)
// ---------------------------------------------
export async function handleUpdateDeliveryRates(request, env, auth) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const { default_home_delivery_fee, default_office_delivery_fee, exceptions } = body;

    // ---- التحقق من الأسعار الافتراضية ----
    const defaultHome = Number(default_home_delivery_fee);
    const defaultOffice = Number(default_office_delivery_fee);
    if (!Number.isFinite(defaultHome) || defaultHome < 0) {
        return jsonResponse({ error: "سعر التوصيل الافتراضي للمنزل غير صالح" }, 400);
    }
    if (!Number.isFinite(defaultOffice) || defaultOffice < 0) {
        return jsonResponse({ error: "سعر التوصيل الافتراضي لمكتب التوصيل غير صالح" }, 400);
    }

    // ---- التحقق من قائمة الاستثناءات (اختيارية، قد تكون فارغة) ----
    const exceptionsList = Array.isArray(exceptions) ? exceptions : [];
    const seenCodes = new Set();
    for (const ex of exceptionsList) {
        if (!ex.wilaya_code || !WILAYA_CODE_REGEX.test(ex.wilaya_code)) {
            return jsonResponse({ error: "رمز ولاية غير صالح بأحد الاستثناءات" }, 400);
        }
        if (seenCodes.has(ex.wilaya_code)) {
            return jsonResponse({ error: `ولاية مكررة بالاستثناءات: ${ex.wilaya_code}` }, 400);
        }
        seenCodes.add(ex.wilaya_code);
        const home = Number(ex.home_price);
        const office = Number(ex.office_price);
        if (!Number.isFinite(home) || home < 0 || !Number.isFinite(office) || office < 0) {
            return jsonResponse({ error: `سعر غير صالح لولاية ${ex.wilaya_code}` }, 400);
        }
    }

    // ---- دفعة واحدة ذرّية: تحديث الافتراضي + حذف كل الاستثناءات القديمة + إدراج الجديدة معاً ----
    // (نفس مبدأ الدفعات الذرّية المستخدم بـhandleActivateVendor بملف admin.js)
    const batchStatements = [
        env.DB.prepare(
            "UPDATE vendors SET default_home_delivery_fee = ?, default_office_delivery_fee = ? WHERE id = ?"
        ).bind(defaultHome, defaultOffice, auth.vendor_id),
        env.DB.prepare("DELETE FROM vendor_delivery_rates WHERE vendor_id = ?").bind(auth.vendor_id)
    ];
    for (const ex of exceptionsList) {
        batchStatements.push(
            env.DB.prepare(
                "INSERT INTO vendor_delivery_rates (vendor_id, wilaya_code, home_price, office_price) VALUES (?, ?, ?, ?)"
            ).bind(auth.vendor_id, ex.wilaya_code, Number(ex.home_price), Number(ex.office_price))
        );
    }
    await env.DB.batch(batchStatements);

    return jsonResponse({ message: "تم حفظ أسعار التوصيل بنجاح" });
}
