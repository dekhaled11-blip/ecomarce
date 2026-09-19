// ============================================
// وحدة تسجيل ودخول التاجر
// ============================================
import { hashPassword, verifyPassword, signJWT, buildRateLimitKey, getRateLimitCount, recordFailedAttempt, RATE_LIMIT_MAX_ATTEMPTS } from "./security.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRIAL_DAYS = 7;

// تحويل اسم المتجر لرابط قابل للمشاركة: إزالة الرموز الخطرة بالروابط، استبدال الفراغات بشرطة
// (نُبقي الحروف العربية كما هي عمداً — رابط بالعربية أوضح وأسهل تذكراً لتجار وزبائن يتحدثون العربية)
function slugify(storeName) {
    return storeName
        .trim()
        .replace(/[?&#/%+]/g, "")
        .replace(/\s+/g, "-");
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

// POST /api/vendors/register
export async function handleRegister(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة (JSON خاطئ)" }, 400);
    }

    const { store_name, owner_name, email, password, phone } = body;

    // ---- التحقق من صحة المدخلات (لا نثق أبداً بمدخلات المستخدم) ----
    if (!store_name || store_name.trim().length < 2) {
        return jsonResponse({ error: "اسم المتجر مطلوب (حرفين على الأقل)" }, 400);
    }
    if (!owner_name || owner_name.trim().length < 2) {
        return jsonResponse({ error: "اسم صاحب المتجر مطلوب" }, 400);
    }
    if (!email || !EMAIL_REGEX.test(email)) {
        return jsonResponse({ error: "البريد الإلكتروني غير صالح" }, 400);
    }
    if (!password || password.length < 8) {
        return jsonResponse({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" }, 400);
    }
    if (!phone || phone.replace(/\D/g, "").length < 9) {
        return jsonResponse({ error: "رقم الهاتف غير صالح" }, 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = phone.replace(/\s/g, "");

    // ---- التحقق من عدم تكرار البريد الإلكتروني أو رقم الهاتف ----
    // (رقم الهاتف فريد أيضاً لمنع نفس الشخص من إنشاء أكثر من حساب تاجر ببريد مختلف)
    const existing = await env.DB.prepare("SELECT id FROM vendors WHERE email = ? OR phone = ?")
        .bind(normalizedEmail, normalizedPhone).first();
    if (existing) {
        return jsonResponse({ error: "هذا البريد الإلكتروني أو رقم الهاتف مسجّل مسبقاً بحساب تاجر آخر" }, 409);
    }

    const passwordHash = await hashPassword(password);
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // توليد رابط فريد (Slug) من اسم المتجر، مع إعادة محاولة برقم إضافي عند وجود تكرار
    const baseSlug = slugify(store_name);
    let slug = baseSlug;
    let attempt = 1;
    while (await env.DB.prepare("SELECT id FROM vendors WHERE slug = ?").bind(slug).first()) {
        attempt += 1;
        slug = `${baseSlug}-${attempt}`;
    }

    const result = await env.DB.prepare(
        `INSERT INTO vendors (store_name, slug, owner_name, email, password_hash, phone, status, trial_ends_at)
         VALUES (?, ?, ?, ?, ?, ?, 'trial', ?)`
    ).bind(store_name.trim(), slug, owner_name.trim(), normalizedEmail, passwordHash, normalizedPhone, trialEndsAt).run();

    const vendorId = result.meta.last_row_id;

    // إصدار رمز دخول مباشرة حتى ينتقل التاجر للوحة تحكمه فور التسجيل
    const token = await signJWT({ vendor_id: vendorId, email: normalizedEmail }, env.JWT_SECRET);

    return jsonResponse({
        message: "تم إنشاء متجرك بنجاح",
        token,
        vendor: {
            id: vendorId,
            store_name: store_name.trim(),
            status: "trial",
            trial_ends_at: trialEndsAt
        }
    }, 201);
}

// POST /api/vendors/login
export async function handleLogin(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const { email, password } = body;
    if (!email || !password) {
        return jsonResponse({ error: "البريد الإلكتروني وكلمة المرور مطلوبان" }, 400);
    }

    const normalizedEmail = email.trim().toLowerCase();

    // فحص الحظر أولاً (قراءة KV واحدة) — قبل أي استعلام D1، حتى نوفر قراءة D1 كاملة على المحاولات المحظورة أصلاً
    const rateLimitKey = buildRateLimitKey("vendor-login", request, normalizedEmail);
    const attempts = await getRateLimitCount(env, rateLimitKey);
    if (attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
        return jsonResponse({ error: "محاولات دخول كثيرة جداً. يرجى المحاولة مجدداً بعد 15 دقيقة." }, 429);
    }

    const vendor = await env.DB.prepare(
        "SELECT id, store_name, password_hash, status, trial_ends_at, logo_url FROM vendors WHERE email = ?"
    ).bind(normalizedEmail).first();

    // رسالة خطأ عامة وموحّدة سواء كان البريد غير موجود أو كلمة المرور خاطئة
    // (معيار أمان عالمي: لا نكشف للمهاجم أي بريد مسجّل فعلاً في النظام)
    // نسجّل المحاولة الفاشلة هنا فقط (كتابة KV واحدة) — ليس عند الفحص أعلاه
    const genericError = async () => {
        await recordFailedAttempt(env, rateLimitKey, attempts);
        return jsonResponse({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" }, 401);
    };

    if (!vendor) return await genericError();

    const validPassword = await verifyPassword(password, vendor.password_hash);
    if (!validPassword) return await genericError();

    if (vendor.status === "suspended") {
        return jsonResponse({ error: "هذا الحساب معلّق. يرجى التواصل مع الدعم." }, 403);
    }

    const token = await signJWT({ vendor_id: vendor.id, email: normalizedEmail }, env.JWT_SECRET);

    return jsonResponse({
        message: "تم تسجيل الدخول بنجاح",
        token,
        vendor: {
            id: vendor.id,
            store_name: vendor.store_name,
            status: vendor.status,
            trial_ends_at: vendor.trial_ends_at,
            logo_url: vendor.logo_url
        }
    });
}
