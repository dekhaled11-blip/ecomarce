// ============================================
// وحدة إرسال إثبات دفع الاشتراك من طرف التاجر
// ============================================

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

const SUBSCRIPTION_PRICE = 1500; // دج — سعر الاشتراك الشهري الثابت حالياً

// ---------------------------------------------
// POST /api/vendors/payments — إرسال إثبات دفع الاشتراك الشهري (محمي: تسجيل دخول التاجر)
// ---------------------------------------------
export async function handleSubmitPayment(request, env, auth) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const { payment_method, receipt_url } = body;

    if (!payment_method || payment_method.trim().length < 2) {
        return jsonResponse({ error: "طريقة الدفع مطلوبة" }, 400);
    }
    if (!receipt_url || typeof receipt_url !== "string") {
        return jsonResponse({ error: "يجب إرفاق صورة إيصال الدفع أولاً عبر مسار رفع الصور" }, 400);
    }
    // تحقق بسيط أن الرابط المُرسَل هو فعلاً رابط صورة رفعها هذا التاجر بالذات عبر R2
    // (يمنع تاجراً من إرسال رابط صورة عشوائي من الإنترنت كإثبات دفع مزيّف)
    const expectedPrefix = `${env.R2_PUBLIC_URL}/vendors/${auth.vendor_id}/`;
    if (!receipt_url.startsWith(expectedPrefix)) {
        return jsonResponse({ error: "رابط الإيصال غير صالح" }, 400);
    }

    // منع إرسال أكثر من إثبات دفع بانتظار المراجعة بنفس الوقت (يحافظ على وضوح طابور المراجعة عند المشرف)
    const existingPending = await env.DB.prepare(
        "SELECT id FROM vendor_payments WHERE vendor_id = ? AND status = 'pending'"
    ).bind(auth.vendor_id).first();
    if (existingPending) {
        return jsonResponse({ error: "لديك بالفعل إثبات دفع بانتظار المراجعة. يرجى الانتظار حتى تتم مراجعته." }, 409);
    }

    const vendor = await env.DB.prepare("SELECT status FROM vendors WHERE id = ?")
        .bind(auth.vendor_id).first();
    if (!vendor) return jsonResponse({ error: "التاجر غير موجود" }, 404);
    if (vendor.status === "suspended") {
        return jsonResponse({ error: "هذا الحساب معلّق. يرجى التواصل مع الدعم." }, 403);
    }

    const periodStart = new Date().toISOString().slice(0, 10);
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // دفعة واحدة (batch) ذرّية: تسجيل الدفعة + تحويل حالة التاجر إلى "بانتظار الدفع"
    // (حتى يظهر فوراً بطابور تفعيل المشرف بغض النظر عن حالته السابقة: تجربة أو نشط قارب على الانتهاء)
    await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO vendor_payments (vendor_id, amount, payment_method, receipt_url, period_start, period_end, status)
             VALUES (?, ?, ?, ?, ?, ?, 'pending')`
        ).bind(auth.vendor_id, SUBSCRIPTION_PRICE, payment_method.trim(), receipt_url, periodStart, periodEnd),
        env.DB.prepare("UPDATE vendors SET status = 'pending_payment' WHERE id = ? AND status != 'suspended'")
            .bind(auth.vendor_id)
    ]);

    return jsonResponse({ message: "تم إرسال إثبات الدفع بنجاح، بانتظار مراجعة المشرف" }, 201);
}
