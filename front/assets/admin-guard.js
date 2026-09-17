// ============================================
// حارس صفحات لوحة تحكم المشرف — يُستدعى بكل صفحة محمية
// يتطلب أن تحتوي الصفحة على عناصر بهذه المعرّفات: adminName, logoutBtn
// ============================================

if (!localStorage.getItem("admin_token")) {
    window.location.href = "admin-login.html";
}

document.addEventListener("DOMContentLoaded", () => {
    const adminInfo = JSON.parse(localStorage.getItem("admin_info") || "{}");

    const nameEl = document.getElementById("adminName");
    const logoutEl = document.getElementById("logoutBtn");

    if (nameEl) nameEl.textContent = adminInfo.name || "المشرف";

    if (logoutEl) {
        logoutEl.addEventListener("click", (e) => {
            e.preventDefault();
            localStorage.removeItem("admin_token");
            localStorage.removeItem("admin_info");
            window.location.href = "admin-login.html";
        });
    }
});
