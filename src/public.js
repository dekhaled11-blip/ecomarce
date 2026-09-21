// ============================================
// وحدة التصفح العام (بدون تسجيل دخول)
// تُستخدم من الصفحة الرئيسية، صفحة المتجر، وصفحة المنتج
// كل هذه المسارات للقراءة فقط ولا تكشف بيانات حساسة (كلمات مرور، بريد التاجر... إلخ)
// ============================================

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            // تخزين مؤقت قصير على حافة Cloudflare لتقليل القراءات المتكررة من D1
            // (البيانات هنا لا تتغيّر كل ثانية، فلا داعي لقراءة القاعدة بكل زيارة)
            "Cache-Control": "public, max-age=60"
        }
    });
}

// حالات التاجر التي يُسمح بظهور متجره للعموم
// (pending_payment و suspended لا يظهران - يخلق حافزاً لتسوية الاشتراك، ويحمي من عرض متجر معلّق)
const PUBLIC_VENDOR_STATUSES = ["trial", "active"];
const ALLOWED_CATEGORIES = ["electronics", "clothing", "shoes", "beauty", "furniture"];
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

// ---------------------------------------------
// GET /api/public/vendors — قائمة المتاجر الظاهرة للعموم (بحث + ترقيم صفحات)
// ---------------------------------------------
export async function handlePublicListVendors(request, env) {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(url.searchParams.get("limit") || String(DEFAULT_PAGE_SIZE))));
    const offset = (page - 1) * limit;
    const search = url.searchParams.get("search");

    const statusPlaceholders = PUBLIC_VENDOR_STATUSES.map(() => "?").join(",");

    // نحسب عدد المنتجات المنشورة لكل متجر بنفس الاستعلام (subquery) بدل استعلام منفصل لكل متجر (تفادي N+1)
    let query = `
        SELECT v.id, v.store_name, v.logo_url, v.cover_url, v.created_at,
               (SELECT COUNT(*) FROM products p WHERE p.vendor_id = v.id AND p.status = 'published' AND p.deleted_at IS NULL) as product_count
        FROM vendors v
        WHERE v.status IN (${statusPlaceholders})
    `;
    let countQuery = `SELECT COUNT(*) as total FROM vendors v WHERE v.status IN (${statusPlaceholders})`;
    const params = [...PUBLIC_VENDOR_STATUSES];

    if (search && search.trim().length > 0) {
        query += " AND v.store_name LIKE ?";
        countQuery += " AND v.store_name LIKE ?";
        params.push(`%${search.trim()}%`);
    }
    query += " ORDER BY v.created_at DESC LIMIT ? OFFSET ?";

    const [{ results: vendors }, countRow] = await Promise.all([
        env.DB.prepare(query).bind(...params, limit, offset).all(),
        env.DB.prepare(countQuery).bind(...params).first()
    ]);

    return jsonResponse({
        vendors,
        pagination: { page, limit, total: countRow.total, total_pages: Math.ceil(countRow.total / limit) }
    });
}

// ---------------------------------------------
// GET /api/public/vendors/:id — صفحة متجر لزائر عادي
// ---------------------------------------------
export async function handlePublicGetVendor(request, env, identifier) {
    const statusPlaceholders = PUBLIC_VENDOR_STATUSES.map(() => "?").join(",");
    const isNumeric = /^\d+$/.test(identifier);
    const column = isNumeric ? "id" : "slug";

    // لا نُرجع أبداً: password_hash, email, status الداخلي، تواريخ الاشتراك/التجربة (بيانات إدارية داخلية)
    const vendor = await env.DB.prepare(`
        SELECT id, store_name, slug, phone, logo_url, cover_url, created_at
        FROM vendors WHERE ${column} = ? AND status IN (${statusPlaceholders})
    `).bind(identifier, ...PUBLIC_VENDOR_STATUSES).first();

    if (!vendor) {
        return jsonResponse({ error: "المتجر غير موجود أو غير متاح حالياً" }, 404);
    }

    return jsonResponse(vendor);
}

// ---------------------------------------------
// GET /api/public/vendors/:id/products — منتجات متجر معيّن (منشورة فقط)
// ---------------------------------------------
export async function handlePublicListVendorProducts(request, env, identifier) {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(url.searchParams.get("limit") || String(DEFAULT_PAGE_SIZE))));
    const offset = (page - 1) * limit;
    const category = url.searchParams.get("category");

    // نتأكد أولاً أن المتجر نفسه ظاهر للعموم، ونحصل على معرّفه الرقمي الفعلي (سواء وصلنا رقماً أو رابطاً مختصراً)
    const statusPlaceholders = PUBLIC_VENDOR_STATUSES.map(() => "?").join(",");
    const isNumeric = /^\d+$/.test(identifier);
    const column = isNumeric ? "id" : "slug";
    const vendor = await env.DB.prepare(`SELECT id FROM vendors WHERE ${column} = ? AND status IN (${statusPlaceholders})`)
        .bind(identifier, ...PUBLIC_VENDOR_STATUSES).first();
    if (!vendor) return jsonResponse({ error: "المتجر غير موجود أو غير متاح حالياً" }, 404);
    const vendorId = vendor.id;

    // صورة الغلاف (أول صورة بالترتيب) تُجلب بـ subquery واحد بدل استعلام منفصل لكل منتج (تفادي N+1)
    // السعر المعروض: COALESCE(display_price, price) — لو المنتج له متغيرات نعرض أرخصها، وإلا سعره الأساسي كالسابق تماماً
    let query = `
        SELECT p.id, p.name, p.category, COALESCE(p.display_price, p.price) as price, p.compare_at_price, p.quantity,
               (SELECT image_url FROM product_images WHERE product_id = p.id ORDER BY sort_order LIMIT 1) as thumbnail
        FROM products p
        WHERE p.vendor_id = ? AND p.status = 'published' AND p.deleted_at IS NULL
    `;
    let countQuery = "SELECT COUNT(*) as total FROM products WHERE vendor_id = ? AND status = 'published' AND deleted_at IS NULL";
    const params = [vendorId];

    if (category && ALLOWED_CATEGORIES.includes(category)) {
        query += " AND p.category = ?";
        countQuery += " AND category = ?";
        params.push(category);
    }
    query += " ORDER BY p.created_at DESC LIMIT ? OFFSET ?";

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
// GET /api/public/products — تصفح/بحث عام عبر كل المتاجر (للصفحة الرئيسية)
// ---------------------------------------------
export async function handlePublicListProducts(request, env) {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(url.searchParams.get("limit") || String(DEFAULT_PAGE_SIZE))));
    const offset = (page - 1) * limit;
    const category = url.searchParams.get("category");
    const search = url.searchParams.get("search");

    const statusPlaceholders = PUBLIC_VENDOR_STATUSES.map(() => "?").join(",");

    // JOIN واحد يجلب اسم المتجر + صورة المنتج مع كل صف — بدل استعلام منفصل لكل منتج (نفس مبدأ تفادي N+1)
    // السعر المعروض: COALESCE(display_price, price) — نفس المبدأ المطبَّق بمنتجات متجر معيّن أعلاه
    let query = `
        SELECT p.id, p.name, p.category, COALESCE(p.display_price, p.price) as price, p.compare_at_price,
               v.id as vendor_id, v.store_name as vendor_name,
               (SELECT image_url FROM product_images WHERE product_id = p.id ORDER BY sort_order LIMIT 1) as thumbnail
        FROM products p
        JOIN vendors v ON v.id = p.vendor_id
        WHERE p.status = 'published' AND p.deleted_at IS NULL AND v.status IN (${statusPlaceholders})
    `;
    let countQuery = `
        SELECT COUNT(*) as total FROM products p
        JOIN vendors v ON v.id = p.vendor_id
        WHERE p.status = 'published' AND p.deleted_at IS NULL AND v.status IN (${statusPlaceholders})
    `;
    const params = [...PUBLIC_VENDOR_STATUSES];

    if (category && ALLOWED_CATEGORIES.includes(category)) {
        query += " AND p.category = ?";
        countQuery += " AND p.category = ?";
        params.push(category);
    }
    if (search && search.trim().length > 0) {
        query += " AND p.name LIKE ?";
        countQuery += " AND p.name LIKE ?";
        params.push(`%${search.trim()}%`);
    }
    query += " ORDER BY p.created_at DESC LIMIT ? OFFSET ?";

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
// GET /api/public/products/:id — تفاصيل منتج واحد لزائر عادي
// ---------------------------------------------
export async function handlePublicGetProduct(request, env, productId) {
    const statusPlaceholders = PUBLIC_VENDOR_STATUSES.map(() => "?").join(",");

    const product = await env.DB.prepare(`
        SELECT p.id, p.name, p.description, p.category, p.price, COALESCE(p.display_price, p.price) as display_price,
               p.compare_at_price, p.quantity, p.custom_fields, p.direct_checkout_only,
               v.id as vendor_id, v.store_name as vendor_name, v.phone as vendor_phone
        FROM products p
        JOIN vendors v ON v.id = p.vendor_id
        WHERE p.id = ? AND p.status = 'published' AND p.deleted_at IS NULL AND v.status IN (${statusPlaceholders})
    `).bind(productId, ...PUBLIC_VENDOR_STATUSES).first();

    if (!product) {
        return jsonResponse({ error: "المنتج غير موجود أو غير متاح حالياً" }, 404);
    }

    // منتج واحد فقط، فثلاثة استعلامات إضافية بالتوازي لا تشكل مشكلة N+1 (المتغيرات هي الإضافة الوحيدة الجديدة هنا)
    const [images, attributes, variants] = await Promise.all([
        env.DB.prepare("SELECT image_url FROM product_images WHERE product_id = ? ORDER BY sort_order")
            .bind(productId).all(),
        env.DB.prepare("SELECT attribute_name, attribute_value FROM product_attributes WHERE product_id = ?")
            .bind(productId).all(),
        // نتعمّد عدم إرجاع sku هنا (رمز داخلي خاص بالتاجر لإدارة مخزونه، لا علاقة له بالزبون)
        // بعكس نفس الاستعلام بلوحة التاجر (products.js) الذي يُرجعه كاملاً
        env.DB.prepare("SELECT id, combination, price, quantity, image_url FROM product_variants WHERE product_id = ? ORDER BY id")
            .bind(productId).all()
    ]);

    return jsonResponse({
        ...product,
        custom_fields: product.custom_fields ? JSON.parse(product.custom_fields) : null,
        images: images.results.map(i => i.image_url),
        attributes: attributes.results,
        variants: variants.results
    });
}
