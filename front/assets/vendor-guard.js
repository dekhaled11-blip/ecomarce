// ============================================
// حارس صفحات لوحة تحكم التاجر — يُستدعى بكل صفحة محمية
// يتطلب أن تحتوي الصفحة على عناصر بهذه المعرّفات: vendorName, vendorAvatar, logoutBtn
// ============================================

// فحص فوري قبل أي شيء آخر — يمنع وميض المحتوى المحمي قبل التحويل
if (!localStorage.getItem("vendor_token")) {
    window.location.href = "vendor-login.html";
}

document.addEventListener("DOMContentLoaded", () => {
    const vendorInfo = JSON.parse(localStorage.getItem("vendor_info") || "{}");

    const nameEl = document.getElementById("vendorName");
    const avatarEl = document.getElementById("vendorAvatar");
    const logoutEl = document.getElementById("logoutBtn");

    if (nameEl) nameEl.textContent = vendorInfo.store_name || "تاجر";
    if (avatarEl) avatarEl.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(vendorInfo.store_name || "تاجر")}&background=1d4ed8&color=fff`;

    if (logoutEl) {
        logoutEl.addEventListener("click", (e) => {
            e.preventDefault();
            localStorage.removeItem("vendor_token");
            localStorage.removeItem("vendor_info");
            window.location.href = "vendor-login.html";
        });
    }
});
