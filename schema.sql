-- ============================================
-- قاعدة بيانات منصتي (Cloudflare D1 / SQLite)
-- ============================================

-- جدول التجار
CREATE TABLE vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,     -- اسم مختصر لرابط المتجر القابل للمشاركة (مثال: ?store=متجر-احمد)
    owner_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    logo_url TEXT,               -- رابط الشعار المخزن في R2
    cover_url TEXT,               -- رابط صورة الغلاف المخزنة في R2
    description TEXT,             -- نبذة تعريفية بالمتجر تظهر للزبائن
    return_policy TEXT,           -- سياسة الإرجاع الخاصة بهذا المتجر
    brand_color TEXT NOT NULL DEFAULT '#1d4ed8', -- لون مميز للمتجر (Hex) يُستخدم بصفحة المتجر العامة
    status TEXT NOT NULL DEFAULT 'trial'
        CHECK (status IN ('trial', 'active', 'pending_payment', 'suspended')),
    trial_ends_at TEXT NOT NULL,      -- تاريخ انتهاء الأسبوع التجريبي (ISO 8601)
    subscription_ends_at TEXT,        -- تاريخ انتهاء الاشتراك الشهري الحالي
    trial_warning_sent INTEGER NOT NULL DEFAULT 0,        -- منع تكرار إشعار اقتراب انتهاء التجربة
    subscription_warning_sent INTEGER NOT NULL DEFAULT 0, -- منع تكرار إشعار اقتراب انتهاء الاشتراك
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- جدول المنتجات
CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,          -- electronics / clothing / shoes / beauty / furniture ...
    price REAL NOT NULL,
    compare_at_price REAL,           -- السعر قبل الخصم (اختياري)
    sku TEXT,
    quantity INTEGER NOT NULL DEFAULT 0,
    -- أرخص سعر بين متغيرات المنتج (لو كانت له متغيرات)، وإلا NULL (يُعتمَد وقتها على عمود price مباشرة)
    -- عمداً NULL وليس نسخة مكررة من price: يمنع بيانات قديمة صامتة لو تغيّر price لاحقاً بدون تحديث هذا العمود
    -- محسوبة ومخزّنة مسبقاً (denormalized) خصيصاً حتى تبقى صفحات التصفح العامة
    -- (الرئيسية/المتجر) بنفس عدد القراءات الحالي بالضبط، بدون أي JOIN أو subquery إضافي (عبر COALESCE(display_price, price))
    display_price REAL,
    -- حقول مخصصة حسب فئة المنتج (مثال: {"المعالج":"A17","الذاكرة":"8 جيجا"}) بصيغة JSON
    -- عمود واحد بدل جدول EAV منفصل: يُقرأ ويُكتب مجاناً ضمن نفس عملية SELECT/UPDATE الحالية
    custom_fields TEXT,
    -- حذف ناعم (Soft Delete): يُملأ فقط عند محاولة حذف منتج له طلبات سابقة مرتبطة به
    -- (بدل الحذف الفعلي الذي يفقد دقة السجلات التاريخية للمبيعات) — NULL يعني المنتج غير محذوف
    deleted_at TEXT,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'published')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- صور المنتج (روابط R2 فقط، وليست الصور نفسها)
CREATE TABLE product_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- خصائص المنتج المتاحة (مثال: نوع الخاصية = "اللون"، القيمة = "أسود")
-- ملاحظة: هذا الجدول يبقى كما هو للمنتجات البسيطة بدون متغيرات (وصف نصي فقط، بدون سعر/كمية مستقلة)
CREATE TABLE product_attributes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    attribute_name TEXT NOT NULL,     -- مثال: "اللون"، "المقاس"، "سعة التخزين"
    attribute_value TEXT NOT NULL     -- مثال: "أسود"، "M"، "128 جيجا"
);

-- متغيرات المنتج (Variants) — اختيارية بالكامل لكل منتج
-- كل صف = توليفة واحدة (مثال: أسود+M) بسعر وكمية وSKU مستقلين عن بعضهم
-- منتج بدون أي صف هنا = منتج بسيط عادي، يستمر يعتمد على price/quantity بجدول products مباشرة
CREATE TABLE product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    combination TEXT NOT NULL,       -- نص وصفي جاهز للعرض، مثال: "اللون: أسود، المقاس: M"
    sku TEXT,
    price REAL NOT NULL,             -- سعر هذه التوليفة تحديداً
    quantity INTEGER NOT NULL DEFAULT 0,
    image_url TEXT,                  -- صورة خاصة بهذه التوليفة (اختياري، رابط R2)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- الطلبات (Guest checkout - بدون حساب زبون)
CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL UNIQUE,   -- مثال: ORD-3391
    vendor_id INTEGER NOT NULL REFERENCES vendors(id),
    customer_name TEXT NOT NULL,
    customer_lastname TEXT NOT NULL,
    customer_phone TEXT NOT NULL,        -- يُستخدم مع order_number لتتبع الطلب بدون حساب
    wilaya TEXT NOT NULL,
    commune TEXT NOT NULL,
    full_address TEXT NOT NULL,
    delivery_type TEXT NOT NULL CHECK (delivery_type IN ('home', 'office')),
    delivery_fee REAL NOT NULL DEFAULT 0,
    subtotal REAL NOT NULL,
    total REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'processing', 'shipped', 'delivered', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- عناصر كل طلب (المنتجات المطلوبة + الخاصية المختارة)
CREATE TABLE order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    -- المتغيّر المحدد فعلياً (لو المنتج من نوع فيه متغيرات) — يُستخدم للتحقق والخصم من المخزون الصحيح
    -- NULL لمنتج بسيط بدون متغيرات (يبقى الخصم من products.quantity كما هو حالياً)
    variant_id INTEGER REFERENCES product_variants(id),
    product_name TEXT NOT NULL,      -- نسخة من الاسم وقت الطلب (حتى لو تغيّر لاحقاً)
    selected_attributes TEXT,        -- مثال: "اللون: أسود، المقاس: M"
    unit_price REAL NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1
);

-- إثباتات دفع اشتراك التجار الشهري
CREATE TABLE vendor_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    payment_method TEXT NOT NULL,     -- مثال: BaridiMob، تحويل بنكي
    receipt_url TEXT,                 -- رابط صورة الإيصال في R2
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- جدول المشرفين (لوحة تحكم المنصة)
CREATE TABLE admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- إشعارات التاجر (طلب جديد، تفعيل حساب، رفض دفع...)
CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    type TEXT NOT NULL,          -- new_order / payment_approved / payment_rejected / account_suspended ...
    message TEXT NOT NULL,
    link TEXT,                   -- رابط اختياري (مثال: /vendor-order-detail.html?id=123)
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================
-- فهارس (Indexes) لتسريع الاستعلامات المتكررة
-- ============================================
CREATE INDEX idx_products_vendor ON products(vendor_id);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_deleted ON products(deleted_at);
CREATE INDEX idx_variants_product ON product_variants(product_id);
CREATE INDEX idx_orders_vendor ON orders(vendor_id);
CREATE INDEX idx_orders_tracking ON orders(order_number, customer_phone);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_vendor_payments_vendor ON vendor_payments(vendor_id);
CREATE INDEX idx_notifications_vendor ON notifications(vendor_id, is_read);
