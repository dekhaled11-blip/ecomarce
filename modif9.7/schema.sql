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
    -- أسعار التوصيل الافتراضية لهذا التاجر (تحل محل الرقم الثابت 500/300 على مستوى المنصة كلها)
    -- تُطبَّق على أي ولاية ما خصّص لها التاجر سعراً مختلفاً بجدول vendor_delivery_rates
    default_home_delivery_fee REAL NOT NULL DEFAULT 500,
    default_office_delivery_fee REAL NOT NULL DEFAULT 300,
    -- محجوز لتكامل مستقبلي مع شركات توصيل حقيقية (جلب أسعار حي عبر API الشركة نفسها، وقت الحاجة الفعلية)
    -- NULL لكل التجار حالياً = توصيل يدوي بالكامل؛ الكود والواجهة لا يقرآن هذا العمود إطلاقاً بهذي المرحلة
    delivery_company_id INTEGER DEFAULT NULL,
    -- وضع الشحن: يدوي (الافتراضي، تحكم كامل بالسعر عبر default_home/office_delivery_fee أعلاه)
    -- أو تلقائي (السعر والشحن الفعلي عبر شركة توصيل حقيقية مربوطة، انظر جدول vendor_shipping_credentials)
    shipping_mode TEXT NOT NULL DEFAULT 'manual' CHECK (shipping_mode IN ('manual', 'automatic')),
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
    -- الطلب المباشر: لو 1، صفحة المنتج تعرض زر "اطلب الآن" (يتخطى السلة كلياً) بدل "أضف للسلة"
    -- القيمة الافتراضية 0 تحافظ على سلوك كل المنتجات الحالية والجديدة كما هو تماماً ما لم يُفعّلها التاجر يدوياً
    direct_checkout_only INTEGER NOT NULL DEFAULT 0,
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
    -- بيانات الشحن التلقائي (dzship) — NULL لكل طلب بالوضع اليدوي (السلوك الافتراضي والحالي بالكامل)
    tracking_number TEXT DEFAULT NULL,   -- رقم تتبع الشحنة الفعلي من شركة التوصيل
    label_url TEXT DEFAULT NULL,         -- رابط بوليصة الشحن، لو الشركة توفره
    shipping_status TEXT DEFAULT NULL,   -- حالة الشحنة الحقيقية (created/picked_up/.../delivered/returned)، مستقلة عن status أعلاه
    shipping_courier TEXT DEFAULT NULL,  -- الشركة التي أنشأت الشحنة فعلاً (يلزم للتتبع لو بدّل التاجر شركته لاحقاً)
    shipping_active INTEGER NOT NULL DEFAULT 0 CHECK (shipping_active IN (0, 1)), -- 1 = شحنة لم تصل لحالة نهائية (يُفحص تتبعها)
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

-- البلديات (يُملأ لمرة واحدة من مصدر بيانات رسمي — 1541 بلدية على مستوى 58 ولاية)
CREATE TABLE communes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wilaya_code TEXT NOT NULL,
    name TEXT NOT NULL
);

-- استثناءات أسعار التوصيل اليدوية لكل تاجر — فقط الولايات التي خصّص التاجر لها سعراً مختلفاً
-- عن سعره الافتراضي (vendors.default_home_delivery_fee / default_office_delivery_fee)
CREATE TABLE vendor_delivery_rates (
    vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    wilaya_code TEXT NOT NULL,
    home_price REAL NOT NULL,
    office_price REAL NOT NULL,
    PRIMARY KEY (vendor_id, wilaya_code)
);

-- بيانات اعتماد كل تاجر لدى شركة التوصيل التي اختارها (ميزة الشحن التلقائي) — صف واحد فقط لكل تاجر
-- credentials_encrypted: نص مشفّر بـAES-GCM عبر encryptShippingCredentials بملف src/security.js،
-- وليس نصاً صريحاً أبداً — يُفك تشفيره فقط لحظة الاستدعاء الفعلي لشركة التوصيل
CREATE TABLE vendor_shipping_credentials (
    vendor_id INTEGER PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
    courier TEXT NOT NULL,              -- مثال: yalidine، zrexpress — مطابق تماماً لمفتاح courier بتوثيق dzship
    credentials_encrypted TEXT NOT NULL,
    -- ولاية انطلاق شحنات التاجر — تطلبها Yalidine وعائلتها إجبارياً (موثّق بـopenapi.json)،
    -- وشركات أخرى تتجاهلها بأمان. NULL يعني: أي طلب لشركة تحتاجها سيفشل برد dzship نفسه
    -- (وليس بخطأ من كودنا)، فيرتد النظام تلقائياً للسعر اليدوي الاحتياطي كأي فشل آخر
    from_wilaya INTEGER DEFAULT NULL,
    verified_at TEXT,                   -- تاريخ آخر تحقق ناجح من صحة البيانات (استدعاء تجريبي عند الربط)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- طابور معالجة إنشاء الشحنات — يحترم حدود الاستخدام المشتركة لدى dzship (200 شحنة/ساعة لكل الموقع)
-- بدل استدعاء مباشر فوري. كل صف يُعالَج ثم يُحذف فوراً (نجاحاً أو فشلاً نهائياً) — لا تاريخ دائم هنا
CREATE TABLE shipping_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    vendor_id INTEGER,                  -- لسقف الطابور لكل تاجر وعدالة التوزيع
    stop_desk_id TEXT,                  -- المكتب المختار (للشركات التي تشترط معرّف مكتب)
    stop_desk_commune TEXT,             -- بلدية ذلك المكتب (تشترطها Yalidine وعائلتها)
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing')),
    attempts INTEGER NOT NULL DEFAULT 0,
    -- وقت آخر تحويل لحالة 'processing' — صف عالق بهذه الحالة أكثر من 10 دقائق يعني انهيار التشغيل
    -- أثناء الإنشاء (Worker انقطع منتصف الاستدعاء)، فتُعامَل حالته كغموض (قد تكون الشحنة أُنشئت فعلاً)
    -- ولا يُعاد آلياً — يُبلَّغ التاجر ليتحقق بنفسه قبل أي محاولة يدوية جديدة
    claimed_at TEXT,
    -- موعد المحاولة التالية (تراجع تدريجي عند فشل مؤقت، أو حسب Retry-After من البوابة) — NULL = جاهز فوراً
    -- بدونه كانت المحاولات الخمس ستُستنفد خلال دقائق أثناء أي عطل مؤقت بالبوابة فيُعلَن فشل نهائي بالخطأ
    next_attempt_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================
-- فهارس (Indexes) لتسريع الاستعلامات المتكررة
-- ============================================
CREATE INDEX idx_communes_wilaya ON communes(wilaya_code);
CREATE INDEX idx_products_vendor ON products(vendor_id);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_deleted ON products(deleted_at);
CREATE INDEX idx_variants_product ON product_variants(product_id);
CREATE INDEX idx_orders_vendor ON orders(vendor_id);
CREATE INDEX idx_orders_tracking ON orders(order_number, customer_phone);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_vendor_payments_vendor ON vendor_payments(vendor_id);
CREATE INDEX idx_notifications_vendor ON notifications(vendor_id, is_read);
-- ميزة الشحن التلقائي: فهارس جزئية صغيرة، لا يدخلها إلا الشحنات النشطة فعلاً (كلفة الفحص الدوري ثابتة مهما تراكمت الطلبات القديمة)
CREATE INDEX idx_orders_active_ship ON orders(vendor_id, id) WHERE shipping_active = 1;
-- طلب واحد فقط بالطابور في أي لحظة: يمنع على مستوى القاعدة نفسها إنشاء شحنتين لنفس الطلب لو ضُغط الزر مرتين
CREATE UNIQUE INDEX idx_shipping_queue_order ON shipping_queue(order_id);
