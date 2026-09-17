// ============================================
// إعدادات الاتصال بالـ API — ملف مشترك تستدعيه كل صفحات الموقع
// عدّل الرابط أدناه مرة واحدة فقط بعد نشر الـ Worker، وسيعمل بكل الصفحات تلقائياً
// ============================================
const API_BASE_URL = "https://platform-api.YOUR_SUBDOMAIN.workers.dev";

// دالة مساعدة موحّدة لكل نداءات الـ API — تتعامل مع رمز الدخول (JWT) والأخطاء بشكل متسق
async function apiRequest(path, options = {}) {
    // اختيار التوكن المناسب حسب نوع المسار، بدل الاعتماد على أولوية عشوائية
    // (يمنع خطأ إرسال توكن تاجر لمسار مشرف أو العكس لو كان الاثنان مخزّنين بنفس المتصفح)
    const isAdminPath = path.startsWith("/api/admin/");
    const token = isAdminPath
        ? localStorage.getItem("admin_token")
        : localStorage.getItem("vendor_token");

    const headers = { ...(options.headers || {}) };

    // لا نضيف Content-Type يدوياً عند إرسال FormData (رفع صور) — المتصفح يحدده تلقائياً بنفسه
    if (!(options.body instanceof FormData)) {
        headers["Content-Type"] = "application/json";
    }
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }

    let response;
    try {
        response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
    } catch (networkError) {
        // فشل الاتصال نفسه (لا إنترنت، أو الخادم غير متاح) — مختلف عن خطأ يرجعه الخادم
        throw new Error("تعذّر الاتصال بالخادم. تحقق من اتصالك بالإنترنت وحاول مجدداً.");
    }

    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error("استجابة غير متوقعة من الخادم.");
    }

    if (!response.ok) {
        throw new Error(data.error || "حدث خطأ غير متوقع.");
    }

    return data;
}
