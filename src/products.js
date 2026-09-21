// ============================================
// وحدة إدارة المنتجات (إضافة / تعديل / حذف / عرض)
// كل مسار هنا محمي: يتطلب تسجيل دخول التاجر (auth.vendor_id)
// ============================================

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

const ALLOWED_CATEGORIES = ["electronics", "clothing", "shoes", "beauty", "furniture"];
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_VARIANTS_PER_PRODUCT = 30; // سقف معقول يمنع إساءة الاستخدام (batch كتابة ضخم غير مبرر)
const MAX_CUSTOM_FIELD_VALUE_LENGTH = 200;

// الحقول المخصصة المسموحة لكل فئة — تعريف مركزي (نفس فلسفة ALLOWED_CATEGORIES أعلاه)
// أي مفتاح غير موجود بقائمة فئته يُرفض، لمنع إدخال بيانات عشوائية غير منظّمة
const CATEGORY_CUSTOM_FIELDS = {
    electronics: ["المعالج", "الذاكرة العشوائية", "مساحة التخزين", "مدة الضمان"],
    clothing: ["نوع القماش", "تعليمات الغسيل", "بلد الصنع"],
    shoes: ["المادة", "بلد الصنع"],
    beauty: ["المكوّنات", "تاريخ الصلاحية", "الحجم/الوزن"],
    furniture: ["المادة", "الأبعاد", "وزن الشحن"]
};

// ---------------------------------------------
// دوال مساعدة مشتركة (تُستخدم بكل من الإنشاء والتعديل، لتفادي تكرار نفس منطق التحقق)
// ---------------------------------------------

// يتحقق من صيغة مصفوفة المتغيرات ويُرجع رسالة خطأ أو null لو كل شيء سليم
function validateVariants(variants, env, vendorId) {
    if (!Array.isArray(variants)) return "صيغة المتغيرات غير صالحة";
    if (variants.length > MAX_VARIANTS_PER_PRODUCT) {
        return `الحد الأقصى ${MAX_VARIANTS_PER_PRODUCT} متغيّراً لكل منتج`;
    }
    const expectedImagePrefix = `${env.R2_PUBLIC_URL}/vendors/${vendorId}/`;
    for (const v of variants) {
        if (!v.combination || typeof v.combination !== "string" || v.combination.trim().length === 0 || v.combination.length > 200) {
            return "وصف كل متغيّر مطلوب (200 حرف كحد أقصى)";
        }
        const priceNum = Number(v.price);
        if (!v.price || isNaN(priceNum) || priceNum <= 0) {
            return `سعر المتغيّر "${v.combination}" يجب أن يكون رقماً أكبر من صفر`;
        }
        const qtyNum = Number(v.quantity ?? 0);
        if (isNaN(qtyNum) || qtyNum < 0 || !Number.isInteger(qtyNum)) {
            return `كمية المتغيّر "${v.combination}" غير صالحة`;
        }
        if (v.sku && (typeof v.sku !== "string" || v.sku.length > 50)) {
            return "رمز SKU غير صالح لأحد المتغيرات";
        }
        if (v.image_url && (typeof v.image_url !== "string" || !v.image_url.startsWith(expectedImagePrefix))) {
            return "رابط صورة أحد المتغيرات غير صالح";
        }
    }
    return null;
}

// أرخص سعر بين المتغيرات (يُحسب من البيانات المُرسَلة مباشرة، بدون أي قراءة إضافية لقاعدة البيانات)
function computeDisplayPrice(variants) {
    if (!variants || variants.length === 0) return null;
    return Math.min(...variants.map(v => Number(v.price)));
}

// يتحقق من صيغة الحقول المخصصة وفق فئة المنتج، ويُرجع رسالة خطأ أو null
function validateCustomFields(customFields, category) {
    if (typeof customFields !== "object" || customFields === null || Array.isArray(customFields)) {
        return "صيغة الحقول المخصصة غير صالحة";
    }
    const allowedKeys = CATEGORY_CUSTOM_FIELDS[category] || [];
    for (const [key, value] of Object.entries(customFields)) {
        if (!allowedKeys.includes(key)) {
            return `الحقل "${key}" غير متاح لهذه الفئة`;
        }
        if (value !== null && (typeof value !== "string" && typeof value !== "number")) {
            return `قيمة الحقل "${key}" غير صالحة`;
        }
        if (String(value).length > MAX_CUSTOM_FIELD_VALUE_LENGTH) {
            return `قيمة الحقل "${key}" طويلة جداً`;
        }
    }
    return null;
}

// ---------------------------------------------
// POST /api/products — إضافة منتج جديد
// ---------------------------------------------
export async function handleCreateProduct(request, env, auth) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const { name, description, category, price, compare_at_price, sku, quantity, images, attributes, status, variants, custom_fields, direct_checkout_only } = body;

    // ---- التحقق من صحة المدخلات ----
    if (!name || name.trim().length < 2) {
        return jsonResponse({ error: "اسم المنتج مطلوب" }, 400);
    }
    if (!category || !ALLOWED_CATEGORIES.includes(category)) {
        return jsonResponse({ error: "القسم غير صالح" }, 400);
    }
    const priceNum = Number(price);
    if (!price || isNaN(priceNum) || priceNum <= 0) {
        return jsonResponse({ error: "السعر يجب أن يكون رقماً أكبر من صفر" }, 400);
    }
    const quantityNum = Number(quantity ?? 0);
    if (isNaN(quantityNum) || quantityNum < 0) {
        return jsonResponse({ error: "الكمية غير صالحة" }, 400);
    }
    if (images && (!Array.isArray(images) || images.length > 4)) {
        return jsonResponse({ error: "يمكن إضافة 4 صور كحد أقصى لكل منتج" }, 400);
    }
    if (attributes && !Array.isArray(attributes)) {
        return jsonResponse({ error: "صيغة الخصائص غير صالحة" }, 400);
    }
    // المتغيرات اختيارية بالكامل — منتج بدون "variants" يبقى يعمل تماماً كمنتج بسيط بـprice/quantity فقط
    if (variants !== undefined) {
        const variantsError = validateVariants(variants, env, auth.vendor_id);
        if (variantsError) return jsonResponse({ error: variantsError }, 400);
    }
    if (custom_fields !== undefined) {
        const customFieldsError = validateCustomFields(custom_fields, category);
        if (customFieldsError) return jsonResponse({ error: customFieldsError }, 400);
    }

    // السعر المعروض بصفحات التصفح: أرخص متغيّر لو وُجدت متغيرات، وإلا NULL (والاعتماد وقتها على عمود price مباشرة)
    // ملاحظة: عمداً NULL وليس نسخة من priceNum — لو تُرك مساوياً لـprice عند الإنشاء، وعدّل التاجر لاحقاً
    // السعر الأساسي بدون لمس المتغيرات، يصير display_price قديماً وخاطئاً بصمت دون أي تحديث له
    const displayPrice = variants && variants.length > 0 ? computeDisplayPrice(variants) : null;

    // ---- إدخال المنتج + الصور + الخصائص + المتغيرات في دفعة واحدة (batch) ----
    // نستعمل env.DB.batch بدل استعلامات منفصلة متتالية لتقليل عدد الرحلات (round-trips) لقاعدة البيانات
    const initialStatus = status === "published" ? "published" : "draft";
    const insertProduct = env.DB.prepare(
        `INSERT INTO products (vendor_id, name, description, category, price, compare_at_price, sku, quantity, status, display_price, custom_fields, direct_checkout_only)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        auth.vendor_id, name.trim(), description?.trim() || null, category,
        priceNum, compare_at_price ? Number(compare_at_price) : null,
        sku?.trim() || null, quantityNum, initialStatus, displayPrice,
        custom_fields ? JSON.stringify(custom_fields) : null,
        direct_checkout_only ? 1 : 0
    );

    const productResult = await insertProduct.run();
    const productId = productResult.meta.last_row_id;

    const batchStatements = [];
    (images || []).forEach((url, index) => {
        batchStatements.push(
            env.DB.prepare("INSERT INTO product_images (product_id, image_url, sort_order) VALUES (?, ?, ?)")
                .bind(productId, url, index)
        );
    });
    (attributes || []).forEach((attr) => {
        if (attr.name && attr.value) {
            batchStatements.push(
                env.DB.prepare("INSERT INTO product_attributes (product_id, attribute_name, attribute_value) VALUES (?, ?, ?)")
                    .bind(productId, attr.name.trim(), attr.value.trim())
            );
        }
    });
    (variants || []).forEach((v) => {
        batchStatements.push(
            env.DB.prepare(
                "INSERT INTO product_variants (product_id, combination, sku, price, quantity, image_url) VALUES (?, ?, ?, ?, ?, ?)"
            ).bind(productId, v.combination.trim(), v.sku?.trim() || null, Number(v.price), Number(v.quantity ?? 0), v.image_url || null)
        );
    });

    if (batchStatements.length > 0) {
        await env.DB.batch(batchStatements); // كتابة واحدة مجمّعة بدل كتابات منفصلة متتالية
    }

    return jsonResponse({ message: "تم إضافة المنتج بنجاح", product_id: productId }, 201);
}

// ---------------------------------------------
// GET /api/products — قائمة منتجات التاجر الحالي (مع ترقيم صفحات)
// ---------------------------------------------
export async function handleListProducts(request, env, auth) {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(url.searchParams.get("limit") || String(DEFAULT_PAGE_SIZE))));
    const offset = (page - 1) * limit;
    const statusFilter = url.searchParams.get("status"); // اختياري: draft / published

    // استعلام واحد للمنتجات + استعلام واحد منفصل فقط للعدد الإجمالي (لأجل الترقيم)
    // ملاحظة: لا نجلب هنا صور/خصائص كل منتج تفادياً لمشكلة N+1 — تُجلب فقط عند فتح منتج واحد بالتفصيل
    let query = `
        SELECT id, name, category, price, compare_at_price, display_price, sku, quantity, status, created_at,
               (SELECT image_url FROM product_images WHERE product_id = products.id ORDER BY sort_order LIMIT 1) as thumbnail
        FROM products WHERE vendor_id = ? AND deleted_at IS NULL
    `;
    let countQuery = "SELECT COUNT(*) as total FROM products WHERE vendor_id = ? AND deleted_at IS NULL";
    const params = [auth.vendor_id];

    if (statusFilter && ["draft", "published"].includes(statusFilter)) {
        query += " AND status = ?";
        countQuery += " AND status = ?";
        params.push(statusFilter);
    }
    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

    const [{ results: products }, countRow] = await Promise.all([
        env.DB.prepare(query).bind(...params, limit, offset).all(),
        env.DB.prepare(countQuery).bind(...params).first()
    ]);

    return jsonResponse({
        products,
        pagination: { page, limit, total: countRow.total, total_pages: Math.ceil(countRow.total / limit) }
    });
}

// ---------------------------------------------
// GET /api/products/:id — تفاصيل منتج واحد (مع صوره وخصائصه)
// ---------------------------------------------
export async function handleGetProduct(request, env, auth, productId) {
    const product = await env.DB.prepare(
        "SELECT * FROM products WHERE id = ? AND vendor_id = ? AND deleted_at IS NULL"
    ).bind(productId, auth.vendor_id).first();

    if (!product) {
        return jsonResponse({ error: "المنتج غير موجود" }, 404);
    }

    // منتج واحد فقط هنا، لذا 3 استعلامات إضافية لا تشكل مشكلة N+1 (المشكلة تحدث فقط داخل حلقات على عدة منتجات)
    const [images, attributes, variants] = await Promise.all([
        env.DB.prepare("SELECT id, image_url, sort_order FROM product_images WHERE product_id = ? ORDER BY sort_order")
            .bind(productId).all(),
        env.DB.prepare("SELECT id, attribute_name, attribute_value FROM product_attributes WHERE product_id = ?")
            .bind(productId).all(),
        env.DB.prepare("SELECT id, combination, sku, price, quantity, image_url FROM product_variants WHERE product_id = ? ORDER BY id")
            .bind(productId).all()
    ]);

    return jsonResponse({
        ...product,
        custom_fields: product.custom_fields ? JSON.parse(product.custom_fields) : null,
        images: images.results,
        attributes: attributes.results,
        variants: variants.results
    });
}

// ---------------------------------------------
// PUT /api/products/:id — تعديل منتج
// ---------------------------------------------
export async function handleUpdateProduct(request, env, auth, productId) {
    // التحقق من الملكية أولاً (لا يجوز لتاجر تعديل منتج تاجر آخر)
    // نجلب category بنفس الاستعلام (بدون أي تكلفة إضافية — نفس الصف) لاستخدامها لاحقاً بالتحقق من الحقول المخصصة
    const existing = await env.DB.prepare("SELECT id, category FROM products WHERE id = ? AND vendor_id = ? AND deleted_at IS NULL")
        .bind(productId, auth.vendor_id).first();
    if (!existing) {
        return jsonResponse({ error: "المنتج غير موجود أو لا تملك صلاحية تعديله" }, 404);
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const { name, description, category, price, compare_at_price, sku, quantity, status, variants, custom_fields, direct_checkout_only } = body;

    if (category && !ALLOWED_CATEGORIES.includes(category)) {
        return jsonResponse({ error: "القسم غير صالح" }, 400);
    }
    if (status && !["draft", "published"].includes(status)) {
        return jsonResponse({ error: "الحالة غير صالحة" }, 400);
    }
    if (price !== undefined && (isNaN(Number(price)) || Number(price) <= 0)) {
        return jsonResponse({ error: "السعر غير صالح" }, 400);
    }
    // الفئة الفعلية لهذا التحقق: الجديدة لو أُرسلت بهذا الطلب، وإلا الحالية المحفوظة أصلاً
    const effectiveCategory = category || existing.category;
    if (variants !== undefined) {
        const variantsError = validateVariants(variants, env, auth.vendor_id);
        if (variantsError) return jsonResponse({ error: variantsError }, 400);
    }
    if (custom_fields !== undefined) {
        const customFieldsError = validateCustomFields(custom_fields, effectiveCategory);
        if (customFieldsError) return jsonResponse({ error: customFieldsError }, 400);
    }

    // تحديث ديناميكي: فقط الحقول المُرسَلة فعلاً (بدون استعلام SELECT إضافي لدمج القديم بالجديد)
    const fields = [];
    const values = [];
    const fieldMap = { name, description, category, price, compare_at_price, sku, quantity, status };
    for (const [key, value] of Object.entries(fieldMap)) {
        if (value !== undefined) {
            fields.push(`${key} = ?`);
            values.push(value);
        }
    }
    if (custom_fields !== undefined) {
        fields.push("custom_fields = ?");
        values.push(JSON.stringify(custom_fields));
    }
    // مثل custom_fields أعلاه: قيمة منطقية صريحة (0 أو 1)، تُحدَّث فقط لو أُرسلت فعلاً بهذا الطلب
    if (direct_checkout_only !== undefined) {
        fields.push("direct_checkout_only = ?");
        values.push(direct_checkout_only ? 1 : 0);
    }
    // display_price يُعاد حسابه فقط لو أُرسلت مصفوفة متغيرات بهذا الطلب تحديداً (بدون أي قراءة إضافية، من نفس البيانات المُرسَلة)
    if (variants !== undefined) {
        fields.push("display_price = ?");
        values.push(variants.length > 0 ? computeDisplayPrice(variants) : null);
    }
    if (fields.length === 0) {
        return jsonResponse({ error: "لا يوجد أي تعديل مُرسَل" }, 400);
    }
    fields.push("updated_at = datetime('now')");

    const updateStatement = env.DB.prepare(
        `UPDATE products SET ${fields.join(", ")} WHERE id = ? AND vendor_id = ?`
    ).bind(...values, productId, auth.vendor_id);

    if (variants === undefined) {
        // لا تعديل على المتغيرات بهذا الطلب: تحديث بسيط بأمر واحد كما كان سابقاً
        await updateStatement.run();
    } else {
        // استراتيجية "استبدال كامل": حذف كل المتغيرات القديمة وإدخال المجموعة الجديدة كاملة
        // بنفس الـbatch الواحد (رحلة واحدة لقاعدة البيانات، ذرّية). أبسط وأضمن من مطابقة
        // تدريجية (diff) بين القديم والجديد، والفرق بعدد الصفوف المكتوبة مهمل لصغر حجم المتغيرات عادة
        const batchStatements = [
            updateStatement,
            env.DB.prepare("DELETE FROM product_variants WHERE product_id = ?").bind(productId)
        ];
        variants.forEach((v) => {
            batchStatements.push(
                env.DB.prepare(
                    "INSERT INTO product_variants (product_id, combination, sku, price, quantity, image_url) VALUES (?, ?, ?, ?, ?, ?)"
                ).bind(productId, v.combination.trim(), v.sku?.trim() || null, Number(v.price), Number(v.quantity ?? 0), v.image_url || null)
            );
        });
        await env.DB.batch(batchStatements);
    }

    return jsonResponse({ message: "تم تحديث المنتج بنجاح" });
}

// ---------------------------------------------
// POST /api/products/:id/images — إضافة صورة لمنتج موجود (بعد رفعها إلى R2)
// ---------------------------------------------
export async function handleAddProductImage(request, env, auth, productId) {
    const product = await env.DB.prepare("SELECT id FROM products WHERE id = ? AND vendor_id = ? AND deleted_at IS NULL")
        .bind(productId, auth.vendor_id).first();
    if (!product) return jsonResponse({ error: "المنتج غير موجود أو لا تملك صلاحية تعديله" }, 404);

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const { image_url } = body;
    if (!image_url || typeof image_url !== "string") {
        return jsonResponse({ error: "رابط الصورة مطلوب" }, 400);
    }
    // التحقق أن الصورة فعلاً مرفوعة من هذا التاجر بالذات عبر R2 (يمنع إدخال روابط خارجية عشوائية)
    const expectedPrefix = `${env.R2_PUBLIC_URL}/vendors/${auth.vendor_id}/`;
    if (!image_url.startsWith(expectedPrefix)) {
        return jsonResponse({ error: "رابط الصورة غير صالح" }, 400);
    }

    const countRow = await env.DB.prepare("SELECT COUNT(*) as total FROM product_images WHERE product_id = ?")
        .bind(productId).first();
    if (countRow.total >= 4) {
        return jsonResponse({ error: "تم الوصول للحد الأقصى (4 صور لكل منتج)" }, 400);
    }

    const insertResult = await env.DB.prepare("INSERT INTO product_images (product_id, image_url, sort_order) VALUES (?, ?, ?)")
        .bind(productId, image_url, countRow.total).run();

    return jsonResponse({ message: "تمت إضافة الصورة بنجاح", id: insertResult.meta.last_row_id }, 201);
}

// ---------------------------------------------
// DELETE /api/products/:id/images/:imageId — حذف صورة من منتج
// ---------------------------------------------
export async function handleDeleteProductImage(request, env, auth, productId, imageId) {
    // التحقق من الملكية والحذف بأمر واحد فقط، عبر ربط المنتج بالتاجر داخل نفس الاستعلام
    const result = await env.DB.prepare(
        `DELETE FROM product_images WHERE id = ? AND product_id IN
         (SELECT id FROM products WHERE id = ? AND vendor_id = ? AND deleted_at IS NULL)`
    ).bind(imageId, productId, auth.vendor_id).run();

    if (result.meta.changes === 0) {
        return jsonResponse({ error: "الصورة غير موجودة أو لا تملك صلاحية حذفها" }, 404);
    }
    return jsonResponse({ message: "تم حذف الصورة بنجاح" });
}
// ---------------------------------------------
// DELETE /api/products/:id — حذف منتج
// حذف فعلي كامل لو المنتج بدون أي طلبات سابقة، أو حذف ناعم (أرشفة) لو له سجل مبيعات
// (معيار عالمي: لا يُفقد تاريخ الطلبات القديمة بحذف المنتج المرتبط بها فعلياً من القاعدة)
// ---------------------------------------------
export async function handleDeleteProduct(request, env, auth, productId) {
    // التحقق من الملكية أولاً
    const product = await env.DB.prepare(
        "SELECT id FROM products WHERE id = ? AND vendor_id = ? AND deleted_at IS NULL"
    ).bind(productId, auth.vendor_id).first();
    if (!product) {
        return jsonResponse({ error: "المنتج غير موجود أو لا تملك صلاحية حذفه" }, 404);
    }

    const hasOrders = await env.DB.prepare(
        "SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1"
    ).bind(productId).first();

    if (hasOrders) {
        // حذف ناعم: يختفي من كل واجهات العرض لكن يبقى محفوظاً لسلامة سجلات الطلبات القديمة
        await env.DB.prepare(
            "UPDATE products SET deleted_at = datetime('now') WHERE id = ? AND vendor_id = ?"
        ).bind(productId, auth.vendor_id).run();
        return jsonResponse({ message: "تمت أرشفة المنتج (له طلبات سابقة، لذا لم يُحذف نهائياً للحفاظ على دقة سجلات المبيعات)" });
    }

    // ON DELETE CASCADE بالـ schema يحذف صور/خصائص/متغيرات المنتج تلقائياً بدون استعلامات إضافية يدوية
    const result = await env.DB.prepare(
        "DELETE FROM products WHERE id = ? AND vendor_id = ?"
    ).bind(productId, auth.vendor_id).run();

    if (result.meta.changes === 0) {
        return jsonResponse({ error: "المنتج غير موجود أو لا تملك صلاحية حذفه" }, 404);
    }

    return jsonResponse({ message: "تم حذف المنتج بنجاح" });
}
