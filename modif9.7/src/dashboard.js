// ============================================
// وحدة نظرة عامة (Dashboard) للتاجر
// كل الاستعلامات هنا للقراءة فقط، ومصممة لتفادي أي استعلام زائد
// ============================================

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

// ---------------------------------------------
// GET /api/vendor/badges — عدد الطلبات الجديدة + عدد الإشعارات غير المقروءة، باستعلام D1 واحد فقط
// (subqueries بدل استعلامين منفصلين) — مخصص لشارات السايدبار وجرس الهيدر بكل صفحات لوحة التاجر.
// الواجهة الأمامية تخزّن النتيجة مؤقتاً (Cache) لتقليل تكرار الاستدعاء — راجع sidebar-badges.js
// ---------------------------------------------
export async function handleGetVendorBadgeCounts(request, env, auth) {
    const row = await env.DB.prepare(`
        SELECT
            (SELECT COUNT(*) FROM orders WHERE vendor_id = ? AND status = 'new') as new_orders,
            (SELECT COUNT(*) FROM notifications WHERE vendor_id = ? AND is_read = 0) as unread_notifications
    `).bind(auth.vendor_id, auth.vendor_id).first();

    return jsonResponse({
        new_orders: row.new_orders || 0,
        unread_notifications: row.unread_notifications || 0
    });
}

// ---------------------------------------------
// GET /api/vendor/dashboard-stats — كل أرقام النظرة العامة بـ4 استعلامات فقط
// ---------------------------------------------
export async function handleDashboardStats(request, env, auth) {
    const vendorId = auth.vendor_id;

    // إحصائيات آخر 7 أيام: نحسب التواريخ بأنفسنا حتى نُرجع صفراً لليوم اللي ما فيه مبيعات
    // (بدل ما نترك الواجهة الأمامية تخمن الأيام الناقصة من نتيجة GROUP BY)
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i);
        last7Days.push(d.toISOString().slice(0, 10));
    }

    // 4 استعلامات فقط، تُنفَّذ بالتوازي — كل واحد يجمع عدة أرقام دفعة واحدة بدل استعلام لكل رقم
    const [productStats, orderStats, vendor, revenueByDay] = await Promise.all([

        // استعلام واحد لكل إحصائيات المنتجات (بدل 4 استعلامات COUNT منفصلة)
        env.DB.prepare(`
            SELECT
                COUNT(*) as total_products,
                SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) as published_count,
                SUM(CASE WHEN quantity > 0 AND quantity <= 5 THEN 1 ELSE 0 END) as low_stock_count,
                SUM(CASE WHEN quantity = 0 THEN 1 ELSE 0 END) as out_of_stock_count
            FROM products WHERE vendor_id = ? AND deleted_at IS NULL
        `).bind(vendorId).first(),

        // استعلام واحد لعدد الطلبات + الطلبات الجديدة + الإيراد الفعلي (من الطلبات المُسلَّمة فقط)
        env.DB.prepare(`
            SELECT
                COUNT(*) as total_orders,
                SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_orders_count,
                SUM(CASE WHEN status = 'delivered' THEN total ELSE 0 END) as total_revenue
            FROM orders WHERE vendor_id = ?
        `).bind(vendorId).first(),

        // حالة الحساب — من نفس صف التاجر، بدون جدول إضافي
        env.DB.prepare(`SELECT status, trial_ends_at, subscription_ends_at FROM vendors WHERE id = ?`)
            .bind(vendorId).first(),

        // إيراد كل يوم بآخر 7 أيام دفعة واحدة (GROUP BY) بدل استعلام منفصل لكل يوم
        env.DB.prepare(`
            SELECT date(created_at) as day, SUM(total) as revenue
            FROM orders
            WHERE vendor_id = ? AND status = 'delivered' AND date(created_at) >= date('now', '-6 days')
            GROUP BY day
        `).bind(vendorId).all()

    ]);

    // دمج نتائج آخر 7 أيام مع قائمة التواريخ الكاملة (تعبئة الأيام بدون مبيعات بصفر)
    const revenueMap = new Map(revenueByDay.results.map(r => [r.day, r.revenue]));
    const revenueChart = last7Days.map(day => ({ day, revenue: revenueMap.get(day) || 0 }));

    // حساب الأيام المتبقية من التجربة أو الاشتراك (أياً كان الفعّال حالياً)
    let daysRemaining = null;
    const relevantDate = vendor.status === "trial" ? vendor.trial_ends_at : vendor.subscription_ends_at;
    if (relevantDate) {
        const diffMs = new Date(relevantDate) - new Date();
        daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    }

    return jsonResponse({
        products: {
            total: productStats.total_products || 0,
            published: productStats.published_count || 0,
            low_stock: productStats.low_stock_count || 0,
            out_of_stock: productStats.out_of_stock_count || 0
        },
        orders: {
            total: orderStats.total_orders || 0,
            new: orderStats.new_orders_count || 0,
            total_revenue: orderStats.total_revenue || 0
        },
        account: {
            status: vendor.status,
            days_remaining: daysRemaining
        },
        revenue_chart: revenueChart
    });
}
