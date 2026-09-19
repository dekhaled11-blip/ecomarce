// ============================================
// شارات السايدبار وجرس الهيدر الحيّة (لوحة التاجر والمشرف)
// مع تخزين مؤقت (Cache) بمدة 3 دقائق لتقليل استهلاك قاعدة البيانات —
// عدة صفحات مفتوحة بنفس الوقت (أو تنقل سريع بينها) تشارك نفس القيمة المخزّنة
// بدل ما تعمل استعلاماً منفصلاً بكل تحميل صفحة.
//
// بلوحة التاجر: طلب واحد فقط (/api/vendor/badges) يرجع القيمتين معاً
// (عدد الطلبات الجديدة + عدد الإشعارات غير المقروءة) باستعلام D1 واحد بالخادم —
// عمداً مو طلبين منفصلين، لتقليل عدد الاستعلامات للحد الأدنى الممكن.
// ============================================

const BADGE_CACHE_TTL_MS = 3 * 60 * 1000; // 3 دقائق

async function getCachedData(cacheKey, apiPath) {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
        try {
            const parsed = JSON.parse(cached);
            if (Date.now() - parsed.timestamp < BADGE_CACHE_TTL_MS) {
                return parsed.data; // القيمة لسا صالحة، ما نطلب من الخادم إطلاقاً
            }
        } catch {
            // كاش تالف — نتجاهله ونطلب قيمة جديدة
        }
    }

    try {
        const data = await apiRequest(apiPath);
        localStorage.setItem(cacheKey, JSON.stringify({ data, timestamp: Date.now() }));
        return data;
    } catch {
        // فشل الطلب (مثلاً غير متصل) — لا نكسر الصفحة، فقط لا نعرض شارة
        return null;
    }
}

// لشارات نصية (رقم داخل مستطيل، مثل شارة "الطلبات" بالسايدبار)
function applyBadge(elementId, count) {
    const el = document.getElementById(elementId);
    if (!el) return; // الصفحة الحالية ما فيها هذي الشارة أصلاً — طبيعي
    if (!count) {
        el.classList.add("hidden");
        return;
    }
    el.textContent = count > 99 ? "99+" : String(count);
    el.classList.remove("hidden");
}

// للنقاط الدائرية الصغيرة بدون نص (مثل نقطة جرس الإشعارات) — إظهار/إخفاء فقط
function applyDot(elementId, count) {
    const el = document.getElementById(elementId);
    if (!el) return; // الصفحة الحالية ما فيها هذي النقطة أصلاً — طبيعي
    el.classList.toggle("hidden", !count);
}

document.addEventListener("DOMContentLoaded", async () => {
    // لوحة التاجر: طلب واحد فقط يغذي شارتين (السايدبار + جرس الهيدر)
    if (localStorage.getItem("vendor_token")) {
        const data = await getCachedData("badge_cache_vendor_badges", "/api/vendor/badges");
        if (data) {
            applyBadge("sidebarNewOrdersBadge", data.new_orders);
            applyDot("headerNotifBadge", data.unread_notifications);
        }
    }

    // لوحة المشرف: شارة "طلبات التفعيل"
    if (localStorage.getItem("admin_token")) {
        const data = await getCachedData("badge_cache_admin_pending", "/api/admin/vendors/pending-count");
        if (data) applyBadge("sidebarPendingActivationBadge", data.count);
    }
});
