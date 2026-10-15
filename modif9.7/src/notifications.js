// ============================================
// وحدة الإشعارات (خاصة بالتاجر)
// ============================================

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

// ---------------------------------------------
// دالة مساعدة يستدعيها أي جزء آخر بالنظام (طلبات، مدفوعات...) لإنشاء إشعار
// كتابة واحدة فقط، لا تُستخدم مباشرة كمسار API
// ---------------------------------------------
export async function createNotification(env, vendorId, type, message, link = null) {
    await env.DB.prepare(
        "INSERT INTO notifications (vendor_id, type, message, link) VALUES (?, ?, ?, ?)"
    ).bind(vendorId, type, message, link).run();
}

// ---------------------------------------------
// GET /api/vendor/notifications — قائمة إشعارات التاجر (محمي)
// ---------------------------------------------
export async function handleListNotifications(request, env, auth) {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(url.searchParams.get("limit") || String(DEFAULT_PAGE_SIZE))));
    const offset = (page - 1) * limit;
    const unreadOnly = url.searchParams.get("unread_only") === "true";

    let query = "SELECT id, type, message, link, is_read, created_at FROM notifications WHERE vendor_id = ?";
    let countQuery = "SELECT COUNT(*) as total FROM notifications WHERE vendor_id = ?";
    const unreadCountQuery = "SELECT COUNT(*) as total FROM notifications WHERE vendor_id = ? AND is_read = 0";
    const params = [auth.vendor_id];

    if (unreadOnly) {
        query += " AND is_read = 0";
        countQuery += " AND is_read = 0";
    }
    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

    // 3 استعلامات بالتوازي: النتائج + العدد الإجمالي (للترقيم) + عدد غير المقروء (لعرضه كشارة بأي صفحة)
    const [{ results: notifications }, countRow, unreadRow] = await Promise.all([
        env.DB.prepare(query).bind(...params, limit, offset).all(),
        env.DB.prepare(countQuery).bind(...params).first(),
        env.DB.prepare(unreadCountQuery).bind(auth.vendor_id).first()
    ]);

    return jsonResponse({
        notifications,
        unread_count: unreadRow.total,
        pagination: { page, limit, total: countRow.total, total_pages: Math.ceil(countRow.total / limit) }
    });
}

// ---------------------------------------------
// PUT /api/vendor/notifications/:id/read — تعليم إشعار واحد كمقروء
// ---------------------------------------------
export async function handleMarkNotificationRead(request, env, auth, notificationId) {
    const result = await env.DB.prepare(
        "UPDATE notifications SET is_read = 1 WHERE id = ? AND vendor_id = ?"
    ).bind(notificationId, auth.vendor_id).run();

    if (result.meta.changes === 0) {
        return jsonResponse({ error: "الإشعار غير موجود" }, 404);
    }
    return jsonResponse({ message: "تم تعليم الإشعار كمقروء" });
}

// ---------------------------------------------
// PUT /api/vendor/notifications/read-all — تعليم كل الإشعارات كمقروءة
// ---------------------------------------------
export async function handleMarkAllNotificationsRead(request, env, auth) {
    await env.DB.prepare(
        "UPDATE notifications SET is_read = 1 WHERE vendor_id = ? AND is_read = 0"
    ).bind(auth.vendor_id).run();

    return jsonResponse({ message: "تم تعليم كل الإشعارات كمقروءة" });
}
