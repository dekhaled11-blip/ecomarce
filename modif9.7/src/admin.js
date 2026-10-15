// ============================================
// وحدة لوحة المشرف: تسجيل دخول + عرض التجار + تفعيل الحسابات
// ============================================
import { hashPassword, verifyPassword, signJWT, buildRateLimitKey, getRateLimitCount, recordFailedAttempt, RATE_LIMIT_MAX_ATTEMPTS } from "./security.js";
import { createNotification } from "./notifications.js";

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const SUBSCRIPTION_DAYS = 30;
const VENDOR_STATUSES = ["trial", "active", "pending_payment", "suspended"];

// ---------------------------------------------
// POST /api/admin/setup — إنشاء أول حساب مشرف فقط (محمي بمفتاح سرّي، ويعمل مرة واحدة فقط)
// لا يوجد مسار عام لتسجيل مشرفين جدد بعد ذلك (المشرفون يُضافون لاحقاً من مشرف موجود فقط)
// ---------------------------------------------
export async function handleAdminSetup(request, env) {
    const setupKey = request.headers.get("X-Setup-Key");
    if (!setupKey || setupKey !== env.ADMIN_SETUP_KEY) {
        return jsonResponse({ error: "غير مصرّح" }, 403);
    }

    const existingAdmin = await env.DB.prepare("SELECT id FROM admins LIMIT 1").first();
    if (existingAdmin) {
        return jsonResponse({ error: "تم إعداد حساب مشرف مسبقاً. هذا المسار متاح مرة واحدة فقط." }, 409);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const { name, email, password } = body;
    if (!name || name.trim().length < 2) return jsonResponse({ error: "الاسم مطلوب" }, 400);
    if (!email || !EMAIL_REGEX.test(email)) return jsonResponse({ error: "البريد الإلكتروني غير صالح" }, 400);
    if (!password || password.length < 8) return jsonResponse({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" }, 400);

    const passwordHash = await hashPassword(password);
    await env.DB.prepare("INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?)")
        .bind(name.trim(), email.trim().toLowerCase(), passwordHash).run();

    return jsonResponse({ message: "تم إنشاء حساب المشرف بنجاح" }, 201);
}

// ---------------------------------------------
// POST /api/admin/login
// ---------------------------------------------
export async function handleAdminLogin(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const { email, password } = body;
    if (!email || !password) return jsonResponse({ error: "البريد الإلكتروني وكلمة المرور مطلوبان" }, 400);

    const normalizedEmail = email.trim().toLowerCase();

    // فحص الحظر أولاً (قراءة KV واحدة) — قبل أي استعلام D1
    const rateLimitKey = buildRateLimitKey("admin-login", request, normalizedEmail);
    const attempts = await getRateLimitCount(env, rateLimitKey);
    if (attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
        return jsonResponse({ error: "محاولات دخول كثيرة جداً. يرجى المحاولة مجدداً بعد 15 دقيقة." }, 429);
    }

    const admin = await env.DB.prepare("SELECT id, name, password_hash FROM admins WHERE email = ?")
        .bind(normalizedEmail).first();

    const genericError = async () => {
        await recordFailedAttempt(env, rateLimitKey, attempts);
        return jsonResponse({ error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" }, 401);
    };
    if (!admin) return await genericError();

    const validPassword = await verifyPassword(password, admin.password_hash);
    if (!validPassword) return await genericError();

    const token = await signJWT({ admin_id: admin.id, email: normalizedEmail }, env.JWT_SECRET);
    return jsonResponse({ message: "تم تسجيل الدخول بنجاح", token, admin: { id: admin.id, name: admin.name } });
}

// ---------------------------------------------
// GET /api/admin/vendors — قائمة كل التجار (بحث + فلترة + ترقيم صفحات)
// ---------------------------------------------
export async function handleListVendors(request, env) {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(url.searchParams.get("limit") || String(DEFAULT_PAGE_SIZE))));
    const offset = (page - 1) * limit;
    const statusFilter = url.searchParams.get("status");
    const search = url.searchParams.get("search");

    let query = `SELECT id, store_name, owner_name, email, status, trial_ends_at, subscription_ends_at, created_at,
                        (SELECT COUNT(*) FROM products WHERE vendor_id = vendors.id AND deleted_at IS NULL) as product_count
                 FROM vendors WHERE 1=1`;
    let countQuery = `SELECT COUNT(*) as total FROM vendors WHERE 1=1`;
    const params = [];

    if (statusFilter && VENDOR_STATUSES.includes(statusFilter)) {
        query += " AND status = ?";
        countQuery += " AND status = ?";
        params.push(statusFilter);
    }
    if (search && search.trim().length > 0) {
        query += " AND (store_name LIKE ? OR email LIKE ?)";
        countQuery += " AND (store_name LIKE ? OR email LIKE ?)";
        const term = `%${search.trim()}%`;
        params.push(term, term);
    }
    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

    // إحصائيات الحالات لكل التجار (بدون فلترة) — لبطاقات الأعلى، استعلام واحد مجمّع بدل 4 استعلامات منفصلة
    const statusCountsQuery = `SELECT status, COUNT(*) as count FROM vendors GROUP BY status`;

    const [{ results: vendors }, countRow, { results: statusCountsRaw }] = await Promise.all([
        env.DB.prepare(query).bind(...params, limit, offset).all(),
        env.DB.prepare(countQuery).bind(...params).first(),
        env.DB.prepare(statusCountsQuery).all()
    ]);

    const statusCounts = { trial: 0, active: 0, pending_payment: 0, suspended: 0 };
    statusCountsRaw.forEach(row => { statusCounts[row.status] = row.count; });

    return jsonResponse({
        vendors,
        status_counts: statusCounts,
        pagination: { page, limit, total: countRow.total, total_pages: Math.ceil(countRow.total / limit) }
    });
}

// ---------------------------------------------
// GET /api/admin/vendors/:id — تفاصيل تاجر + سجل مدفوعاته
// ---------------------------------------------
export async function handleGetVendor(request, env, vendorId) {
    const vendor = await env.DB.prepare(
        "SELECT id, store_name, owner_name, email, phone, status, trial_ends_at, subscription_ends_at, created_at FROM vendors WHERE id = ?"
    ).bind(vendorId).first();

    if (!vendor) return jsonResponse({ error: "التاجر غير موجود" }, 404);

    const { results: payments } = await env.DB.prepare(
        "SELECT id, amount, payment_method, receipt_url, period_start, period_end, status, created_at FROM vendor_payments WHERE vendor_id = ? ORDER BY created_at DESC"
    ).bind(vendorId).all();

    return jsonResponse({ ...vendor, payments });
}

// ---------------------------------------------
// GET /api/admin/vendors/pending-count — عدد التجار بانتظار تفعيل الحساب فقط (محمي)
// استعلام واحد خفيف جداً (COUNT بسيط)، مخصص لشارة السايدبار — عمداً منفصل عن
// handleActivationQueue الأثقل (JOIN كامل + بيانات كل تاجر ودفعته). الواجهة الأمامية
// تخزّن النتيجة مؤقتاً (Cache) لتقليل تكرار الاستدعاء — راجع sidebar-badges.js
// ---------------------------------------------
export async function handleGetPendingActivationCount(request, env) {
    const row = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM vendors WHERE status = 'pending_payment'"
    ).first();
    return jsonResponse({ count: row.count || 0 });
}

// ---------------------------------------------
// GET /api/admin/activation-queue — التجار الذين ينتظرون تفعيل الحساب بعد الدفع
// ---------------------------------------------
export async function handleActivationQueue(request, env) {
    // استعلام واحد يجمع التاجر مع آخر دفعة معلّقة له (بدلاً من استعلام منفصل لكل تاجر لجلب دفعته - يتجنب N+1)
    const { results } = await env.DB.prepare(`
        SELECT v.id as vendor_id, v.store_name, v.owner_name, v.email, v.trial_ends_at,
               p.id as payment_id, p.amount, p.payment_method, p.receipt_url, p.created_at as payment_date
        FROM vendors v
        LEFT JOIN vendor_payments p ON p.vendor_id = v.id AND p.status = 'pending'
        WHERE v.status = 'pending_payment'
        ORDER BY v.trial_ends_at ASC
    `).all();

    return jsonResponse({ queue: results });
}

// ---------------------------------------------
// PUT /api/admin/vendors/:id/activate — تفعيل حساب التاجر بعد التحقق من الدفع
// ---------------------------------------------
export async function handleActivateVendor(request, env, vendorId) {
    const vendor = await env.DB.prepare("SELECT id, status FROM vendors WHERE id = ?")
        .bind(vendorId).first();
    if (!vendor) return jsonResponse({ error: "التاجر غير موجود" }, 404);

    const pendingPayment = await env.DB.prepare(
        "SELECT id FROM vendor_payments WHERE vendor_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
    ).bind(vendorId).first();

    const now = new Date();
    const subscriptionEndsAt = new Date(now.getTime() + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // دفعة واحدة (batch) ذرّية: تفعيل التاجر + اعتماد الدفعة معاً — إما ينجح الاثنان أو لا شيء
    const batchStatements = [
        env.DB.prepare("UPDATE vendors SET status = 'active', subscription_ends_at = ?, subscription_warning_sent = 0 WHERE id = ?")
            .bind(subscriptionEndsAt, vendorId)
    ];
    if (pendingPayment) {
        batchStatements.push(
            env.DB.prepare("UPDATE vendor_payments SET status = 'approved' WHERE id = ?").bind(pendingPayment.id)
        );
    }
    await env.DB.batch(batchStatements);

    await createNotification(env, vendorId, "payment_approved", "تم تفعيل حسابك بنجاح. مرحباً بك مجدداً!", null);

    return jsonResponse({ message: "تم تفعيل حساب التاجر بنجاح", subscription_ends_at: subscriptionEndsAt });
}

// ---------------------------------------------
// PUT /api/admin/vendors/:id/remind — إرسال تذكير دفع لتاجر لم يرسل إثبات دفع بعد
// ---------------------------------------------
export async function handleSendPaymentReminder(request, env, vendorId) {
    const vendor = await env.DB.prepare("SELECT id, status FROM vendors WHERE id = ?")
        .bind(vendorId).first();
    if (!vendor) return jsonResponse({ error: "التاجر غير موجود" }, 404);
    if (vendor.status !== "pending_payment") {
        return jsonResponse({ error: "التذكير متاح فقط للتجار بانتظار الدفع" }, 400);
    }

    await createNotification(env, vendorId, "payment_reminder", "تذكير: لم نستلم دفعة اشتراكك بعد. يرجى إتمام الدفع لتفعيل متجرك.", null);

    return jsonResponse({ message: "تم إرسال التذكير بنجاح" });
}


// ---------------------------------------------
// PUT /api/admin/vendors/:id/extend-trial — تمديد الفترة التجريبية عدد أيام محدد
// ---------------------------------------------
export async function handleExtendTrial(request, env, vendorId) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const days = Number(body.days);
    if (!days || days <= 0 || days > 30) {
        return jsonResponse({ error: "عدد الأيام يجب أن يكون بين 1 و30" }, 400);
    }

    const vendor = await env.DB.prepare("SELECT id, status, trial_ends_at FROM vendors WHERE id = ?")
        .bind(vendorId).first();
    if (!vendor) return jsonResponse({ error: "التاجر غير موجود" }, 404);
    if (vendor.status !== "trial" && vendor.status !== "pending_payment") {
        return jsonResponse({ error: "تمديد التجربة متاح فقط للتجار بحالة تجربة أو بانتظار الدفع" }, 400);
    }

    // الأساس هو الأبعد بين تاريخ الانتهاء الحالي والآن (يمنع تمديداً قصيراً لتجربة منتهية أصلاً من تاريخها القديم)
    const baseDate = new Date(Math.max(new Date(vendor.trial_ends_at).getTime(), Date.now()));
    const newTrialEnd = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

    // إعادة الحالة لـ"تجربة" + تصفير علامة التحذير حتى يعمل نظام التنبيه التلقائي صح بالدورة الجديدة
    await env.DB.prepare(
        "UPDATE vendors SET status = 'trial', trial_ends_at = ?, trial_warning_sent = 0 WHERE id = ?"
    ).bind(newTrialEnd, vendorId).run();

    await createNotification(env, vendorId, "trial_extended", `تم تمديد فترتك التجريبية ${days} أيام إضافية من إدارة المنصة.`, null);

    return jsonResponse({ message: "تم تمديد التجربة بنجاح", trial_ends_at: newTrialEnd });
}

export async function handleSuspendVendor(request, env, vendorId) {
    const result = await env.DB.prepare("UPDATE vendors SET status = 'suspended' WHERE id = ?")
        .bind(vendorId).run();
    if (result.meta.changes === 0) return jsonResponse({ error: "التاجر غير موجود" }, 404);

    await createNotification(env, vendorId, "account_suspended", "تم تعليق حسابك من طرف إدارة المنصة. يرجى التواصل مع الدعم لمعرفة السبب.", null);

    return jsonResponse({ message: "تم تعليق حساب التاجر" });
}

// ---------------------------------------------
// PUT /api/admin/vendors/:id/reject-payment — رفض إثبات دفع
// ---------------------------------------------
export async function handleRejectPayment(request, env, vendorId) {
    const pendingPayment = await env.DB.prepare(
        "SELECT id FROM vendor_payments WHERE vendor_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
    ).bind(vendorId).first();

    if (!pendingPayment) return jsonResponse({ error: "لا يوجد إثبات دفع بانتظار المراجعة لهذا التاجر" }, 404);

    await env.DB.prepare("UPDATE vendor_payments SET status = 'rejected' WHERE id = ?")
        .bind(pendingPayment.id).run();

    await createNotification(env, vendorId, "payment_rejected", "تم رفض إثبات الدفع الذي أرسلته. يرجى إرسال إثبات صحيح أو التواصل مع الدعم.", null);

    return jsonResponse({ message: "تم رفض إثبات الدفع" });
}
