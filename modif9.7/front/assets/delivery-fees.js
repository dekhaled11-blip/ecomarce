// ============================================
// جلب رسوم التوصيل الفعلية لتاجر معيّن (تُراعي سعراً خاصاً بالولاية المختارة لو وُجد،
// وإلا سعر التاجر الافتراضي) — بدل أي رقم ثابت بالواجهة الأمامية.
// يُستخدم بصفحتي product.html (نافذة الطلب المباشر) وcheckout.html (كل مجموعة تاجر بالسلة).
//
// تخزين مؤقت بالذاكرة لكل (تاجر، ولاية) طوال عمر الصفحة — يمنع أي تكرار لنفس الطلب
// (تبديل الزبون بين "منزل"/"مكتب توصيل" لا يحتاج طلباً جديداً إطلاقاً، لأن الطلب الواحد
// يرجع السعرين معاً؛ والرجوع لولاية سبق اختيارها بنفس الجلسة لا يحتاج طلباً جديداً أيضاً).
// المسار نفسه مُخزَّن مؤقتاً 60 ثانية على حافة Cloudflare (راجع public.js)، فحتى أول طلب
// لكل مستخدم غالباً لا يصل قاعدة البيانات فعلياً لو طلبه مستخدم آخر لنفس التاجر/الولاية للتو.
//
// قفل السعر (الشحن التلقائي): استجابة التاجر التلقائي تحمل "quote" — رمز موقَّع من الخادم صالح ساعة،
// تُرسله الصفحات مع الطلب (fee_quote) فيُسجَّل بالطلب السعر الذي رآه الزبون نفسه. التاجر اليدوي بلا رمز (quote = null).
// الرمز المخزَّن يُجدَّد تلقائياً قبل انتهائه بدقائق، فلا يصل الزبون الذي أبقى الصفحة مفتوحة طويلاً لرفض الخادم.
// ============================================

const _deliveryFeeCache = new Map(); // key -> { fee: {home, office, quote}, at: وقت الجلب بالمللي ثانية }
const _QUOTE_REFRESH_AFTER_MS = 50 * 60 * 1000; // الرمز صالح 60 دقيقة بالخادم — نجدّده بعد 50 دقيقة احتياطاً

async function fetchVendorDeliveryFee(vendorId, wilayaCode, forceFresh = false) {
    const key = `${vendorId}:${wilayaCode || ""}`;
    const cached = _deliveryFeeCache.get(key);
    if (cached && !forceFresh) {
        const quoteAboutToExpire = cached.fee.quote && (Date.now() - cached.at) > _QUOTE_REFRESH_AFTER_MS;
        if (!quoteAboutToExpire) return cached.fee;
    }

    const qs = wilayaCode ? `?wilaya=${encodeURIComponent(wilayaCode)}` : "";
    // forceFresh يتجاوز كاش المتصفح أيضاً (المسار مُخزَّن 60 ثانية) كي لا يعود لنا الرمز القديم نفسه
    const data = await apiRequest(
        `/api/public/vendors/${encodeURIComponent(vendorId)}/delivery-fee${qs}`,
        forceFresh ? { cache: "reload" } : {}
    );
    const fee = { home: data.home, office: data.office, quote: data.quote || null };

    _deliveryFeeCache.set(key, { fee, at: Date.now() });
    return fee;
}

// تُستخدم لتفادي أي طلب شبكة عندما تكون القيمة الافتراضية متوفرة أصلاً ضمن بيانات جُلبت لغرض آخر
// (مثال: صفحة المنتج تستقبل default_home/office_delivery_fee مجاناً ضمن استجابة /api/public/products/:id)
function seedVendorDefaultDeliveryFee(vendorId, home, office) {
    _deliveryFeeCache.set(`${vendorId}:`, { fee: { home, office, quote: null }, at: Date.now() });
}

// تمسح كل ما خُزِّن لهذا التاجر (كل الولايات) — تُستدعى حين يرفض الخادم رمز السعر (انتهت صلاحيته أو لم يعد مطابقاً)
// ليُجلب السعر من جديد بدل إعادة استعمال رمز قديم
function invalidateVendorDeliveryFee(vendorId) {
    const prefix = `${vendorId}:`;
    for (const key of Array.from(_deliveryFeeCache.keys())) {
        if (key.startsWith(prefix)) _deliveryFeeCache.delete(key);
    }
}
