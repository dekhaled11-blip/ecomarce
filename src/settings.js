// ============================================
// وحدة إعدادات المتجر (شعار، غلاف، وصف، تواصل، سياسة إرجاع، لون مميز)
// ============================================

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_RETURN_POLICY_LENGTH = 1000;

// ---------------------------------------------
// GET /api/vendor/settings — جلب إعدادات المتجر الحالية (محمي)
// ---------------------------------------------
export async function handleGetSettings(request, env, auth) {
    const vendor = await env.DB.prepare(`
        SELECT store_name, slug, phone, logo_url, cover_url, description, return_policy, brand_color
        FROM vendors WHERE id = ?
    `).bind(auth.vendor_id).first();

    if (!vendor) return jsonResponse({ error: "التاجر غير موجود" }, 404);
    return jsonResponse(vendor);
}

// ---------------------------------------------
// PUT /api/vendor/settings — تحديث إعدادات المتجر (محمي)
// ---------------------------------------------
export async function handleUpdateSettings(request, env, auth) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const { store_name, phone, description, return_policy, brand_color, logo_url, cover_url } = body;

    // ---- التحقق من صحة كل حقل مُرسَل فعلاً (تحديث جزئي: فقط الحقول الموجودة بالطلب) ----
    if (store_name !== undefined && store_name.trim().length < 2) {
        return jsonResponse({ error: "اسم المتجر قصير جداً" }, 400);
    }
    if (description !== undefined && description.length > MAX_DESCRIPTION_LENGTH) {
        return jsonResponse({ error: `نبذة المتجر يجب ألا تتجاوز ${MAX_DESCRIPTION_LENGTH} حرف` }, 400);
    }
    if (return_policy !== undefined && return_policy.length > MAX_RETURN_POLICY_LENGTH) {
        return jsonResponse({ error: `سياسة الإرجاع يجب ألا تتجاوز ${MAX_RETURN_POLICY_LENGTH} حرف` }, 400);
    }
    if (brand_color !== undefined && !HEX_COLOR_REGEX.test(brand_color)) {
        return jsonResponse({ error: "صيغة اللون غير صالحة (مثال صحيح: #1d4ed8)" }, 400);
    }
    if (phone !== undefined && phone.replace(/\D/g, "").length < 9) {
        return jsonResponse({ error: "رقم الهاتف غير صالح" }, 400);
    }

    // التحقق أن روابط الصور فعلياً مرفوعة من هذا التاجر بالذات عبر R2 (نفس مبدأ صور المنتجات وإثباتات الدفع)
    const expectedPrefix = `${env.R2_PUBLIC_URL}/vendors/${auth.vendor_id}/`;
    if (logo_url !== undefined && logo_url !== null && !logo_url.startsWith(expectedPrefix)) {
        return jsonResponse({ error: "رابط الشعار غير صالح" }, 400);
    }
    if (cover_url !== undefined && cover_url !== null && !cover_url.startsWith(expectedPrefix)) {
        return jsonResponse({ error: "رابط الغلاف غير صالح" }, 400);
    }

    // ---- التحقق من عدم تكرار رقم الهاتف عند شخص آخر (فقط لو تغيّر فعلاً، لتفادي استعلام غير ضروري) ----
    let normalizedPhone;
    if (phone !== undefined) {
        normalizedPhone = phone.replace(/\s/g, "");
        const currentVendor = await env.DB.prepare("SELECT phone FROM vendors WHERE id = ?")
            .bind(auth.vendor_id).first();
        if (currentVendor.phone !== normalizedPhone) {
            const existing = await env.DB.prepare("SELECT id FROM vendors WHERE phone = ? AND id != ?")
                .bind(normalizedPhone, auth.vendor_id).first();
            if (existing) {
                return jsonResponse({ error: "رقم الهاتف مستخدَم بالفعل من حساب تاجر آخر" }, 409);
            }
        }
    }

    // ---- تحديث ديناميكي: فقط الحقول المُرسَلة فعلاً بطلب واحد ----
    const fields = [];
    const values = [];
    const fieldMap = {
        store_name: store_name?.trim(),
        phone: normalizedPhone,
        description,
        return_policy,
        brand_color,
        logo_url,
        cover_url
    };
    for (const [key, value] of Object.entries(fieldMap)) {
        if (value !== undefined) {
            fields.push(`${key} = ?`);
            values.push(value);
        }
    }
    if (fields.length === 0) {
        return jsonResponse({ error: "لا يوجد أي تعديل مُرسَل" }, 400);
    }

    await env.DB.prepare(`UPDATE vendors SET ${fields.join(", ")} WHERE id = ?`)
        .bind(...values, auth.vendor_id).run();

    return jsonResponse({ message: "تم حفظ إعدادات المتجر بنجاح" });
}
