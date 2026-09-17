// ============================================
// وحدة إدارة سلة المشتريات (محلية عبر localStorage)
// تُستخدم من: product.html, cart.html, checkout.html
// كل عنصر بالسلة: { product_id, vendor_id, vendor_name, name, price,
//                    thumbnail, quantity, selected_attributes, max_quantity }
// ============================================

const CART_STORAGE_KEY = "platform_cart";

// قراءة السلة الحالية من localStorage (آمنة ضد بيانات تالفة)
function getCart() {
    try {
        const raw = localStorage.getItem(CART_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// حفظ السلة + تحديث شارة العدد بكل صفحة تحتوي عنصر id="cartBadge"
function saveCart(cart) {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    updateCartBadge();
}

// مفتاح فريد للعنصر: نفس المنتج بنفس الخصائص المختارة = نفس السطر بالسلة
function cartItemKey(productId, selectedAttributes) {
    return `${productId}::${selectedAttributes || ""}`;
}

// إضافة منتج للسلة (أو زيادة كميته لو موجود أصلاً بنفس الخصائص)
function addToCart(item) {
    const cart = getCart();
    const key = cartItemKey(item.product_id, item.selected_attributes);
    const existing = cart.find(i => cartItemKey(i.product_id, i.selected_attributes) === key);

    if (existing) {
        existing.quantity += item.quantity;
    } else {
        cart.push(item);
    }
    saveCart(cart);
    return cart;
}

// تحديث كمية عنصر معيّن (حذفه تلقائياً لو الكمية وصلت صفر أو أقل)
function updateCartItemQuantity(productId, selectedAttributes, quantity) {
    let cart = getCart();
    const key = cartItemKey(productId, selectedAttributes);

    if (quantity <= 0) {
        cart = cart.filter(i => cartItemKey(i.product_id, i.selected_attributes) !== key);
    } else {
        const item = cart.find(i => cartItemKey(i.product_id, i.selected_attributes) === key);
        if (item) item.quantity = quantity;
    }
    saveCart(cart);
    return cart;
}

// حذف عنصر بالكامل من السلة
function removeFromCart(productId, selectedAttributes) {
    return updateCartItemQuantity(productId, selectedAttributes, 0);
}

// تفريغ السلة بالكامل (يُستخدم بعد إتمام الطلب بنجاح)
function clearCart() {
    localStorage.removeItem(CART_STORAGE_KEY);
    updateCartBadge();
}

// إجمالي عدد القطع بالسلة (لعرضه بشارة أيقونة السلة)
function getCartCount() {
    return getCart().reduce((sum, i) => sum + i.quantity, 0);
}

// إجمالي سعر المنتجات فقط (بدون رسوم توصيل)
function getCartSubtotal() {
    return getCart().reduce((sum, i) => sum + (i.price * i.quantity), 0);
}

// تجميع عناصر السلة حسب المتجر — ضروري لأن الباك اند يُنشئ طلباً منفصلاً لكل تاجر
// (orders.js: POST /api/orders يستقبل vendor_id واحد فقط لكل طلب)
function getCartGroupedByVendor() {
    const cart = getCart();
    const groups = {};
    cart.forEach(item => {
        if (!groups[item.vendor_id]) {
            groups[item.vendor_id] = {
                vendor_id: item.vendor_id,
                vendor_name: item.vendor_name,
                items: [],
                subtotal: 0
            };
        }
        groups[item.vendor_id].items.push(item);
        groups[item.vendor_id].subtotal += item.price * item.quantity;
    });
    return Object.values(groups);
}

// تحديث شارة عدد عناصر السلة بأي أيقونة سلة موجودة بالصفحة الحالية
function updateCartBadge() {
    const badge = document.getElementById("cartBadge");
    if (!badge) return;
    const count = getCartCount();
    if (count > 0) {
        badge.textContent = count > 99 ? "99+" : String(count);
        badge.classList.remove("hidden");
    } else {
        badge.classList.add("hidden");
    }
}

document.addEventListener("DOMContentLoaded", updateCartBadge);
