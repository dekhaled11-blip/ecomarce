// ============================================
// قائمة جانبية منزلقة للهاتف (Mobile Sidebar Drawer)
// تعمل بكل صفحات لوحة التاجر والمشرف — تتطلب هذي العناصر بالصفحة:
// id="mobileMenuBtn" (زر ☰)، id="sidebarNav" (عنصر aside)، id="sidebarBackdrop" (خلفية داكنة)
// ============================================

document.addEventListener("DOMContentLoaded", () => {
    const menuBtn = document.getElementById("mobileMenuBtn");
    const sidebar = document.getElementById("sidebarNav");
    const backdrop = document.getElementById("sidebarBackdrop");
    if (!menuBtn || !sidebar || !backdrop) return; // الصفحة الحالية ما فيها هذي العناصر — طبيعي

    function openSidebar() {
        sidebar.classList.remove("translate-x-full");
        backdrop.classList.remove("hidden");
    }
    function closeSidebar() {
        sidebar.classList.add("translate-x-full");
        backdrop.classList.add("hidden");
    }

    menuBtn.addEventListener("click", openSidebar);
    backdrop.addEventListener("click", closeSidebar);

    // إغلاق تلقائي عند الضغط على أي رابط بالقائمة (تجربة أفضل بالهاتف)
    sidebar.querySelectorAll("a").forEach(link => link.addEventListener("click", closeSidebar));
});
