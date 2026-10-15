-- ============================================
-- Migration النهائية: ميزة الشحن التلقائي (dzship) — تُنفَّذ مرة واحدة فقط على قاعدة البيانات الحية
-- هذا الملف يحل محل migration_shipping.sql القديم بالكامل (لا تنفّذ القديم أبداً).
-- لا تُشغّل schema.sql على قاعدة حية؛ schema.sql لقواعد جديدة فارغة فقط.
--
-- آمنة على قاعدتك الحالية:
--  • كل الأعمدة الجديدة بقيمة افتراضية ثابتة (لا إعادة كتابة للصفوف الموجودة، ولا تغيير على أي بيانات).
--  • كل تاجر موجود يبقى بالوضع اليدوي (shipping_mode = 'manual') تلقائياً.
--  • متوافقة مع الكود الحالي ومع الكود الجديد معاً.
-- ============================================

-- وضع الشحن لكل تاجر: يدوي (الافتراضي = السلوك الحالي 100%) أو تلقائي
ALTER TABLE vendors ADD COLUMN shipping_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK (shipping_mode IN ('manual', 'automatic'));

-- بيانات الشحنة الفعلية (NULL لكل طلب بلا شحنة تلقائية، وهو حال كل الطلبات الموجودة الآن)
ALTER TABLE orders ADD COLUMN tracking_number TEXT DEFAULT NULL;
ALTER TABLE orders ADD COLUMN label_url TEXT DEFAULT NULL;
ALTER TABLE orders ADD COLUMN shipping_status TEXT DEFAULT NULL;
ALTER TABLE orders ADD COLUMN shipping_courier TEXT DEFAULT NULL;

-- 1 = شحنة فعلية لم تصل لحالة نهائية بعد (يُفحص تتبعها دورياً). يُضبط 1 عند إنشاء الشحنة،
-- ويعود 0 عند delivered/returned/cancelled/lost. بفضله لا يقرأ الفحص الدوري إلا الشحنات النشطة،
-- فلا تكبر كلفته مع تراكم الطلبات القديمة (يُحدَّث ضمن نفس جملة UPDATE الموجودة أصلاً: بلا كتابة إضافية)
ALTER TABLE orders ADD COLUMN shipping_active INTEGER NOT NULL DEFAULT 0
    CHECK (shipping_active IN (0, 1));

-- بيانات اعتماد كل تاجر لدى شركة التوصيل — صف واحد لكل تاجر (لا ينمو مع الطلبات)
-- credentials_encrypted مشفّر AES-GCM (src/security.js)، ولا يُحفظ نصاً صريحاً أبداً
CREATE TABLE vendor_shipping_credentials (
    vendor_id INTEGER PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
    courier TEXT NOT NULL,              -- مفتاح courier بتوثيق dzship (yalidine، zrexpress...)
    credentials_encrypted TEXT NOT NULL,
    from_wilaya INTEGER DEFAULT NULL,   -- ولاية انطلاق الشحنات (تشترطها Yalidine وعائلتها)
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- طابور إنشاء الشحنات: يحترم حدود dzship المشتركة (200 شحنة/ساعة و1000/يوم لكل الموقع).
-- كل صف يُعالَج ثم يُحذف فوراً (نجاحاً أو فشلاً نهائياً) — لا تاريخ دائم، فقط "المعلّق حالياً"
CREATE TABLE shipping_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    vendor_id INTEGER,                  -- لسقف الطابور لكل تاجر وعدالة التوزيع (NULL مقبول للصفوف القديمة)
    stop_desk_id TEXT,                  -- المكتب المختار لطلبات المكتب مع الشركات التي تشترط معرّف مكتب
    stop_desk_commune TEXT,             -- بلدية ذلك المكتب (تشترطها Yalidine وعائلتها)
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing')),
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at TEXT,                    -- صف عالق بـ'processing' أكثر من 10 دقائق = حالة غموض (يُبلَّغ التاجر)
    next_attempt_at TEXT,               -- موعد المحاولة التالية (تراجع تدريجي أو Retry-After) — NULL = فوراً
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================
-- الفهارس — فهرسان فقط، وكل فهرس يكلّف كتابة إضافية عند كل تغيير بالصف، فلا يُضاف إلا ما يوفّر أكثر مما يكلّف
-- (جدول الطابور مؤقت وصغير: مسحه كاملاً أرخص من صيانة فهرس عليه عند كل إدخال وتحديث وحذف)
-- ============================================

-- لا يدخلها إلا الشحنات النشطة: كلفة الفحص الدوري ثابتة مهما تراكمت الطلبات المنتهية (يُقرأ منه معرّف الطلب فقط بلا
-- أي قراءة من جدول orders)، وعدّ الشحنات النشطة لتاجر معيّن (حماية تبديل الشركة/فصل الربط) يقرأ مدخلاته هو فقط
-- لا كل طلباته القديمة. الأعمدة (vendor_id, id) لا تكلّف كتابة أكثر من (id) وحده: مدخل واحد يُضاف ويُحذف بكل شحنة
CREATE INDEX idx_orders_active_ship ON orders(vendor_id, id) WHERE shipping_active = 1;

-- طلب واحد فقط بالطابور في أي لحظة: يمنع شحنتين لنفس الطلب لو ضُغط الزر مرتين
CREATE UNIQUE INDEX idx_shipping_queue_order ON shipping_queue(order_id);
