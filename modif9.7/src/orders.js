// ============================================
// وحدة الطلبات: طلب كضيف (Guest Checkout) + تتبع الطلب + إدارة الطلبات من جهة التاجر
// ============================================

import { createNotification } from "./notifications.js";
import { WILAYAS } from "./locations.js";
import { verifyFeeQuote } from "./security.js";
import { getCourierShippingSupport } from "./shipping.js";

// خريطة اسم الولاية → رمزها — الواجهة الأمامية ترسل الاسم (لعرضه بتفاصيل الطلب)، لكن جدول
// vendor_delivery_rates وميزة الشحن التلقائي (dzship) يُفهرَسان بالرمز؛ هذا التحويل بالذاكرة فقط، صفر استعلام قاعدة بيانات إضافي
export const WILAYA_NAME_TO_CODE = new Map(WILAYAS.map(w => [w.name, w.code]));

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

const VALID_DELIVERY_TYPES = new Set(["home", "office"]); // القيم المسموحة فقط؛ السعر نفسه صار ديناميكياً لكل تاجر (راجع أسفل)
const ORDER_STATUSES = ["new", "processing", "shipped", "delivered", "cancelled"];
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function generateOrderNumber() {
    // 6 أرقام عشوائية + جزء من الوقت لتقليل احتمال التصادم لأدنى حد
    const random = Math.floor(100000 + Math.random() * 900000);
    return `ORD-${random}`;
}

// ---------------------------------------------
// POST /api/orders — إنشاء طلب كضيف (بدون تسجيل دخول)
// ---------------------------------------------
export async function handleCreateOrder(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const {
        vendor_id, customer_name, customer_lastname, customer_phone,
        wilaya, commune, full_address, delivery_type, items, fee_quote
    } = body;

    // ---- التحقق من صحة المدخلات ----
    if (!vendor_id) return jsonResponse({ error: "المتجر غير محدد" }, 400);
    if (!customer_name || !customer_lastname) return jsonResponse({ error: "الاسم واللقب مطلوبان" }, 400);
    if (!customer_phone || customer_phone.replace(/\D/g, "").length < 9) {
        return jsonResponse({ error: "رقم الهاتف غير صالح" }, 400);
    }
    if (!wilaya || !commune || !full_address) {
        return jsonResponse({ error: "بيانات العنوان غير مكتملة (الولاية، البلدية، العنوان الكامل)" }, 400);
    }
    if (!delivery_type || !VALID_DELIVERY_TYPES.has(delivery_type)) {
        return jsonResponse({ error: "طريقة التوصيل غير صالحة" }, 400);
    }
    if (!Array.isArray(items) || items.length === 0) {
        return jsonResponse({ error: "السلة فارغة" }, 400);
    }
    for (const item of items) {
        if (!item.product_id || !Number.isInteger(item.quantity) || item.quantity < 1) {
            return jsonResponse({ error: "بيانات أحد المنتجات في السلة غير صالحة" }, 400);
        }
    }

    // ---- التحقق من التاجر (يجب أن يكون نشطاً ليستقبل طلبات) ----
    // نجلب الأسعار الافتراضية بنفس هذا الاستعلام (صفر تكلفة إضافية — نفس الصف المقروء أصلاً)
    const vendor = await env.DB.prepare(
        "SELECT id, status, shipping_mode, default_home_delivery_fee, default_office_delivery_fee FROM vendors WHERE id = ?"
    ).bind(vendor_id).first();
    if (!vendor) return jsonResponse({ error: "المتجر غير موجود" }, 404);
    if (vendor.status === "suspended") {
        return jsonResponse({ error: "هذا المتجر غير متاح حالياً لاستقبال الطلبات" }, 403);
    }

    // ---- جلب كل المنتجات المطلوبة باستعلام واحد (تفادياً لمشكلة N+1) ----
    const productIds = items.map(i => i.product_id);
    const placeholders = productIds.map(() => "?").join(",");
    const { results: products } = await env.DB.prepare(
        `SELECT id, name, price, quantity, status FROM products WHERE vendor_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`
    ).bind(vendor_id, ...productIds).all();

    const productMap = new Map(products.map(p => [p.id, p]));

    // ---- جلب المتغيرات المطلوبة (لو وُجدت) باستعلام واحد إضافي فقط —
    // لا يُنفَّذ إطلاقاً لو كانت السلة تحتوي منتجات بسيطة فقط (صفر تكلفة بالحالة الأكثر شيوعاً حالياً)
    const variantIds = items.filter(i => i.variant_id).map(i => i.variant_id);
    let variantMap = new Map();
    if (variantIds.length > 0) {
        const variantPlaceholders = variantIds.map(() => "?").join(",");
        const { results: variants } = await env.DB.prepare(
            `SELECT id, product_id, combination, price, quantity FROM product_variants WHERE id IN (${variantPlaceholders})`
        ).bind(...variantIds).all();
        variantMap = new Map(variants.map(v => [v.id, v]));
    }

    // ---- التحقق من توفر كل منتج، حالته، وكميته (لا نثق بأي سعر يرسله العميل) ----
    let subtotal = 0;
    const validatedItems = [];
    for (const item of items) {
        const product = productMap.get(item.product_id);
        if (!product) {
            return jsonResponse({ error: `أحد المنتجات لم يعد متوفراً (رقم: ${item.product_id})` }, 400);
        }
        if (product.status !== "published") {
            return jsonResponse({ error: `المنتج "${product.name}" غير متاح حالياً` }, 400);
        }

        if (item.variant_id) {
            // عنصر بمتغيّر محدد: التحقق والخصم يصيران على مستوى المتغيّر تحديداً، لا المنتج ككل
            const variant = variantMap.get(item.variant_id);
            if (!variant || variant.product_id !== product.id) {
                return jsonResponse({ error: `أحد المتغيرات المطلوبة لم يعد متوفراً بمنتج "${product.name}"` }, 400);
            }
            if (variant.quantity < item.quantity) {
                return jsonResponse({ error: `الكمية المطلوبة من "${product.name}" (${variant.combination}) غير متوفرة` }, 409);
            }
            subtotal += variant.price * item.quantity;
            validatedItems.push({
                product_id: product.id,
                variant_id: variant.id,
                product_name: product.name,
                unit_price: variant.price,
                quantity: item.quantity,
                // نص الخاصية المعروض يُؤخذ من المتغيّر المخزَّن بالخادم (موثوق)، وليس من العميل مباشرة
                selected_attributes: variant.combination
            });
        } else {
            // منتج بسيط بدون متغيرات: نفس المنطق الأصلي بالضبط، بدون أي تغيير
            if (product.quantity < item.quantity) {
                return jsonResponse({ error: `الكمية المطلوبة من "${product.name}" غير متوفرة` }, 409);
            }
            subtotal += product.price * item.quantity;
            validatedItems.push({
                product_id: product.id,
                variant_id: null,
                product_name: product.name,
                unit_price: product.price,
                quantity: item.quantity,
                selected_attributes: item.selected_attributes || null
            });
        }
    }

    // ---- حساب رسم التوصيل الفعلي: استثناء مخصّص لهذي الولاية إن وُجد (استعلام واحد مفهرس)،
    // وإلا الأسعار الافتراضية الخاصة بهذا التاجر (مجلوبة أصلاً أعلاه بدون تكلفة إضافية) ----
    const wilayaCode = WILAYA_NAME_TO_CODE.get(wilaya) || null;

    // (أ) قفل سعر الشحن التلقائي: إن أرسلت الواجهة رمز السعر (fee_quote) فهو المرجع الوحيد للرسم — يُسجَّل بالطلب السعر الذي رآه
    // الزبون نفسه (ويُرسَل لشركة التوصيل كمبلغ تحصيل). لا قراءة قاعدة إضافية: يُتحقَّق منه بالذاكرة فقط، ونتخطى استعلام الاستثناء.
    // كل رمز غير صالح للتطبيق (توقيع/انتهاء/تاجر أو ولاية مختلفان، أو عاد التاجر لليدوي بعد إصداره) يُرفض 409 برسالة واضحة
    // بدل أن نحاسب الزبون بسعر مختلف عمّا رآه بصمت — والواجهة تحدّث السعر تلقائياً وتطلب منه المراجعة والتأكيد من جديد
    let deliveryFee;
    if (fee_quote !== undefined && fee_quote !== null && fee_quote !== "") {
        const quote = vendor.shipping_mode === "automatic" ? await verifyFeeQuote(fee_quote, env.JWT_SECRET) : null;
        if (!quote || quote.vendorId !== vendor.id || quote.wilayaCode !== wilayaCode) {
            return jsonResponse({
                error: "تغيّر سعر التوصيل أو انتهت صلاحيته. حدّثنا السعر تلقائياً، راجع المجموع الجديد ثم أكّد طلبك من جديد",
                code: "FEE_QUOTE_STALE"
            }, 409);
        }
        deliveryFee = delivery_type === "home" ? quote.home : quote.office;
    } else {
        // (ب) المسار اليدوي (وكل طلب بلا رمز): كما كان بالضبط — استثناء الولاية إن وُجد (استعلام مفهرس واحد)، وإلا الافتراضي
        const rateException = wilayaCode
            ? await env.DB.prepare(
                "SELECT home_price, office_price FROM vendor_delivery_rates WHERE vendor_id = ? AND wilaya_code = ?"
              ).bind(vendor_id, wilayaCode).first()
            : null;

        deliveryFee = rateException
            ? (delivery_type === "home" ? rateException.home_price : rateException.office_price)
            : (delivery_type === "home" ? vendor.default_home_delivery_fee : vendor.default_office_delivery_fee);
    }

    const total = subtotal + deliveryFee;

    // ---- إنشاء رقم طلب فريد (إعادة محاولة واحدة نادراً عند التصادم) ----
    let orderNumber = generateOrderNumber();
    let orderId;
    try {
        const insertOrder = await env.DB.prepare(
            `INSERT INTO orders (order_number, vendor_id, customer_name, customer_lastname, customer_phone,
                wilaya, commune, full_address, delivery_type, delivery_fee, subtotal, total, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`
        ).bind(
            orderNumber, vendor_id, customer_name.trim(), customer_lastname.trim(), customer_phone.trim(),
            wilaya.trim(), commune.trim(), full_address.trim(), delivery_type, deliveryFee, subtotal, total
        ).run();
        orderId = insertOrder.meta.last_row_id;
    } catch (err) {
        // تصادم نادر جداً في رقم الطلب — نعيد المحاولة مرة واحدة فقط برقم جديد
        orderNumber = generateOrderNumber();
        const retryInsert = await env.DB.prepare(
            `INSERT INTO orders (order_number, vendor_id, customer_name, customer_lastname, customer_phone,
                wilaya, commune, full_address, delivery_type, delivery_fee, subtotal, total, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`
        ).bind(
            orderNumber, vendor_id, customer_name.trim(), customer_lastname.trim(), customer_phone.trim(),
            wilaya.trim(), commune.trim(), full_address.trim(), delivery_type, deliveryFee, subtotal, total
        ).run();
        orderId = retryInsert.meta.last_row_id;
    }

    // ---- دفعة واحدة (batch): إدخال عناصر الطلب + خصم الكمية خصماً ذرّياً (Atomic) ----
    // شرط "quantity >= ?" بأمر التحديث يمنع أي احتمال لبيع كمية أكبر من المتوفر عند تزامن طلبين معاً
    // الخصم يستهدف product_variants لو العنصر مرتبط بمتغيّر، وإلا products كالسابق تماماً
    const batchStatements = [];
    for (const item of validatedItems) {
        batchStatements.push(
            env.DB.prepare(
                `INSERT INTO order_items (order_id, product_id, variant_id, product_name, selected_attributes, unit_price, quantity)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(orderId, item.product_id, item.variant_id, item.product_name, item.selected_attributes, item.unit_price, item.quantity)
        );
        batchStatements.push(
            item.variant_id
                ? env.DB.prepare(
                    `UPDATE product_variants SET quantity = quantity - ? WHERE id = ? AND quantity >= ?`
                  ).bind(item.quantity, item.variant_id, item.quantity)
                : env.DB.prepare(
                    `UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?`
                  ).bind(item.quantity, item.product_id, item.quantity)
        );
    }
    const batchResults = await env.DB.batch(batchStatements);

    // ---- التحقق من نجاح كل عمليات خصم الكمية (تحسباً لتزامن نادر أفلت من الفحص الأول) ----
    const decrementResults = batchResults.filter((_, idx) => idx % 2 === 1); // كل عنصر ثاني هو تحديث الكمية
    const anyFailed = decrementResults.some(r => r.meta.changes === 0);
    if (anyFailed) {
        // تعويض: إلغاء الطلب فوراً لأن أحد المنتجات نفد فعلياً في اللحظة الأخيرة
        await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").bind(orderId).run();
        return jsonResponse({
            error: "نفدت كمية أحد المنتجات للتو أثناء إتمام طلبك. تم إلغاء الطلب، يرجى المحاولة مجدداً."
        }, 409);
    }

    await notifyVendorOfNewOrder(env, vendor_id, orderNumber);

    return jsonResponse({
        message: "تم استلام طلبك بنجاح",
        order_number: orderNumber,
        total
    }, 201);
}

// ملاحظة: الإشعار يُرسَل بعد إرجاع الرد للزبون مباشرة (لا يجب أن يؤخر تأكيد الطلب أو يفشله)
async function notifyVendorOfNewOrder(env, vendorId, orderNumber) {
    try {
        await createNotification(
            env, vendorId, "new_order",
            `لديك طلب جديد برقم ${orderNumber}`,
            null
        );
    } catch (err) {
        // فشل إرسال إشعار لا يجب أبداً أن يُفشل الطلب نفسه — فقط نسجّل الخطأ
        console.error("Failed to create notification:", err);
    }
}

// ---------------------------------------------
// GET /api/orders/track — تتبع الطلب (رقم الطلب + الهاتف معاً، بدون حساب)
// ---------------------------------------------
export async function handleTrackOrder(request, env) {
    const url = new URL(request.url);
    const orderNumber = url.searchParams.get("order_number");
    const phone = url.searchParams.get("phone");

    if (!orderNumber || !phone) {
        return jsonResponse({ error: "رقم الطلب ورقم الهاتف مطلوبان معاً" }, 400);
    }

    // استعلام واحد يستفيد من الفهرس المركّب idx_orders_tracking (سريع حتى مع آلاف الطلبات)
    const order = await env.DB.prepare(
        `SELECT order_number, status, delivery_type, wilaya, commune, subtotal, delivery_fee, total, created_at,
                shipping_status, tracking_number, shipping_courier
         FROM orders WHERE order_number = ? AND customer_phone = ?`
    ).bind(orderNumber.trim(), phone.trim()).first();

    if (!order) {
        // رسالة عامة: لا نكشف هل رقم الطلب صحيح لكن الهاتف خاطئ أو العكس (حماية الخصوصية)
        return jsonResponse({ error: "لم يتم العثور على طلب بهذه المعلومات" }, 404);
    }

    const { results: items } = await env.DB.prepare(
        "SELECT product_name, selected_attributes, unit_price, quantity FROM order_items WHERE order_id = (SELECT id FROM orders WHERE order_number = ?)"
    ).bind(orderNumber.trim()).all();

    return jsonResponse({ ...order, items });
}

// ---------------------------------------------
// GET /api/vendor/orders — قائمة طلبات التاجر الحالي (محمي)
// ---------------------------------------------
export async function handleListVendorOrders(request, env, auth) {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(url.searchParams.get("limit") || String(DEFAULT_PAGE_SIZE))));
    const offset = (page - 1) * limit;
    const statusFilter = url.searchParams.get("status");

    let query = `SELECT id, order_number, customer_name, customer_lastname, customer_phone,
                        delivery_type, wilaya, commune, total, status, created_at, shipping_status, tracking_number,
                        (SELECT GROUP_CONCAT(product_name || ' × ' || quantity, '، ') FROM order_items WHERE order_id = orders.id) as items_summary
                 FROM orders WHERE vendor_id = ?`;
    const params = [auth.vendor_id];

    const validStatusFilter = statusFilter && ORDER_STATUSES.includes(statusFilter) ? statusFilter : null;
    if (validStatusFilter) {
        query += " AND status = ?";
        params.push(validStatusFilter);
    }
    // id كمفتاح ترتيب ثانٍ: ترتيب ثابت للطلبات المتساوية بالتاريخ (وإلا قد يتكرر طلب أو يضيع بين صفحتين متتاليتين)
    query += " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";

    // عدد الطلبات لكل حالة (لبطاقات الإحصائيات) — استعلام واحد مجمّع. ومنه نفسه يُحسب إجمالي الترقيم (بلا فلتر: مجموع كل الحالات،
    // ومع فلتر: عدد تلك الحالة) — فلا حاجة لاستعلام COUNT منفصل يقرأ كل طلبات التاجر مرة أخرى
    const statusCountsQuery = `
        SELECT status, COUNT(*) as count FROM orders WHERE vendor_id = ? GROUP BY status
    `;
    // وضع الشحن وشركة التاجر (صف أو صفان بمفتاح أساسي): تقرر الواجهة إظهار تحديد الطلبات للإنشاء الجماعي من عدمه
    const vendorShippingQuery = `SELECT v.shipping_mode, vsc.courier FROM vendors v
                                 LEFT JOIN vendor_shipping_credentials vsc ON vsc.vendor_id = v.id WHERE v.id = ?`;

    const [{ results: orders }, { results: statusCountsRaw }, vendorShipping] = await Promise.all([
        env.DB.prepare(query).bind(...params, limit, offset).all(),
        env.DB.prepare(statusCountsQuery).bind(auth.vendor_id).all(),
        env.DB.prepare(vendorShippingQuery).bind(auth.vendor_id).first()
    ]);

    const statusCounts = { new: 0, processing: 0, shipped: 0, delivered: 0, cancelled: 0 };
    statusCountsRaw.forEach(row => { statusCounts[row.status] = row.count; });
    const totalOrders = validStatusFilter
        ? (statusCountsRaw.find(row => row.status === validStatusFilter) || { count: 0 }).count
        : statusCountsRaw.reduce((sum, row) => sum + row.count, 0);

    // تاجر تلقائي: أي طلبات هذه الصفحة (بلا شحنة بعد) بالطابور الآن؟ استعلام واحد بفهرس فريد (حتى 10 مفاتيح) — ولا شيء للتاجر اليدوي
    const isAutomatic = !!vendorShipping && vendorShipping.shipping_mode === "automatic" && !!vendorShipping.courier;
    let queuedIds = new Set();
    if (isAutomatic) {
        const waiting = orders.filter(o => !o.tracking_number).map(o => o.id);
        if (waiting.length > 0) {
            const { results: queuedRows } = await env.DB.prepare(
                `SELECT order_id FROM shipping_queue WHERE order_id IN (${waiting.map(() => "?").join(",")})`
            ).bind(...waiting).all();
            queuedIds = new Set(queuedRows.map(r => r.order_id));
        }
    }
    orders.forEach(o => { o.shipping_queued = queuedIds.has(o.id) ? 1 : 0; });

    return jsonResponse({
        orders,
        status_counts: statusCounts,
        pagination: { page, limit, total: totalOrders, total_pages: Math.ceil(totalOrders / limit) },
        shipping: {
            mode: isAutomatic ? "automatic" : "manual",
            courier: isAutomatic ? vendorShipping.courier : null,
            support: isAutomatic ? getCourierShippingSupport(vendorShipping.courier) : null
        }
    });
}

// ---------------------------------------------
// GET /api/vendor/orders/:id — تفاصيل طلب واحد (محمي + تحقق ملكية)
// ---------------------------------------------
export async function handleGetVendorOrder(request, env, auth, orderId) {
    // JOIN بسيط لجلب وضع الشحن الحالي للتاجر (يدوي/تلقائي) وشركته المربوطة بنفس الاستعلام — تقرر الواجهة إظهار
    // زر "إنشاء شحنة" من عدمه، وهل تدعم الشركة هذا النوع من التوصيل (shipping_support)، دون أي استعلام إضافي
    const order = await env.DB.prepare(
        `SELECT o.*, v.shipping_mode as vendor_shipping_mode, vsc.courier as vendor_shipping_courier
         FROM orders o JOIN vendors v ON v.id = o.vendor_id
         LEFT JOIN vendor_shipping_credentials vsc ON vsc.vendor_id = o.vendor_id
         WHERE o.id = ? AND o.vendor_id = ?`
    ).bind(orderId, auth.vendor_id).first();
    if (!order) return jsonResponse({ error: "الطلب غير موجود" }, 404);

    const { results: items } = await env.DB.prepare(
        "SELECT product_name, selected_attributes, unit_price, quantity FROM order_items WHERE order_id = ?"
    ).bind(orderId).all();

    // ما تدعمه الشركة المربوطة (منزل/مكتب وطريقة المكتب) — للتاجر التلقائي فقط؛ دالة نقية بلا أي كلفة
    const shippingSupport = order.vendor_shipping_mode === "automatic" && order.vendor_shipping_courier
        ? getCourierShippingSupport(order.vendor_shipping_courier) : null;
    return jsonResponse({ ...order, items, shipping_support: shippingSupport });
}

// ---------------------------------------------
// PUT /api/vendor/orders/:id/status — تحديث حالة الطلب (محمي + تحقق ملكية)
// ---------------------------------------------
export async function handleUpdateOrderStatus(request, env, auth, orderId) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: "بيانات الطلب غير صالحة" }, 400);
    }

    const { status } = body;
    if (!status || !ORDER_STATUSES.includes(status)) {
        return jsonResponse({ error: "الحالة غير صالحة" }, 400);
    }

    // نحتاج الحالة الحالية أولاً لمعرفة هل هذا الانتقال يدخل/يخرج من "ملغى"
    // (فقط عندها يلزم لمس المخزون؛ باقي الانتقالات — new/processing/shipped/delivered فيما بينها — بلا أي تأثير على الكمية)
    // نجلب tracking_number أيضاً: طلب له شحنة فعلية بشركة توصيل يحتاج تأكيداً صريحاً قبل إلغائه محلياً
    const order = await env.DB.prepare("SELECT status, tracking_number, shipping_courier FROM orders WHERE id = ? AND vendor_id = ?")
        .bind(orderId, auth.vendor_id).first();
    if (!order) {
        return jsonResponse({ error: "الطلب غير موجود أو لا تملك صلاحية تعديله" }, 404);
    }

    const willBeCancelled = status === "cancelled";
    // dzship لا توفر أي مسار لإلغاء شحنة بعد إنشائها (غير موثّق بالـAPI) — الطرد قد يكون بالفعل في الطريق
    // فعلياً عند شركة التوصيل. لذا لا نسمح بإلغائه محلياً بصمت؛ نطلب تأكيداً صريحاً (force) من الواجهة أولاً،
    // بعد أن تعرض للتاجر تحذيراً واضحاً بأن عليه التواصل مع الشركة مباشرة لإلغاء الشحنة الفعلية إن رغب بذلك
    if (willBeCancelled && order.tracking_number && !body.force) {
        return jsonResponse({
            error: "هذا الطلب له شحنة فعلية بشركة التوصيل — إلغاؤه هنا لا يلغي الشحنة تلقائياً",
            requiresConfirmation: true,
            trackingNumber: order.tracking_number,
            courier: order.shipping_courier
        }, 409);
    }

    const wasCancelled = order.status === "cancelled";

    if (wasCancelled === willBeCancelled) {
        // لا تغيير بحالة الإلغاء (مثال: new → processing، أو حتى cancelled → cancelled) — تحديث بسيط كما كان بالضبط
        await env.DB.prepare(
            "UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND vendor_id = ?"
        ).bind(status, orderId, auth.vendor_id).run();
        return jsonResponse({ message: "تم تحديث حالة الطلب بنجاح" });
    }

    // جلب عناصر الطلب (المنتج/المتغيّر المحدد والكمية) لتنفيذ استرجاع أو إعادة خصم صحيح لكل عنصر بمكانه الصحيح
    const { results: orderItems } = await env.DB.prepare(
        "SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = ?"
    ).bind(orderId).all();

    if (willBeCancelled) {
        // إلغاء: استرجاع الكمية للمخزون — عملية جمع بسيطة، غير قابلة للفشل إطلاقاً
        const batchStatements = [
            env.DB.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND vendor_id = ?")
                .bind(status, orderId, auth.vendor_id)
        ];
        orderItems.forEach(item => {
            batchStatements.push(
                item.variant_id
                    ? env.DB.prepare("UPDATE product_variants SET quantity = quantity + ? WHERE id = ?").bind(item.quantity, item.variant_id)
                    : env.DB.prepare("UPDATE products SET quantity = quantity + ? WHERE id = ?").bind(item.quantity, item.product_id)
            );
        });
        await env.DB.batch(batchStatements);
        return jsonResponse({ message: "تم إلغاء الطلب وإعادة الكمية للمخزون بنجاح" });
    }

    // إعادة تفعيل طلب كان ملغياً: إعادة خصم الكمية ذرّياً بنفس حراسة "quantity >= ?" المستخدمة بإنشاء الطلب
    const batchStatements = [
        env.DB.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND vendor_id = ?")
            .bind(status, orderId, auth.vendor_id)
    ];
    orderItems.forEach(item => {
        batchStatements.push(
            item.variant_id
                ? env.DB.prepare("UPDATE product_variants SET quantity = quantity - ? WHERE id = ? AND quantity >= ?").bind(item.quantity, item.variant_id, item.quantity)
                : env.DB.prepare("UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity >= ?").bind(item.quantity, item.product_id, item.quantity)
        );
    });
    const batchResults = await env.DB.batch(batchStatements);
    const decrementResults = batchResults.slice(1); // كل نتيجة بعد أمر تحديث الحالة نفسه (بنفس الترتيب)
    const failedIndex = decrementResults.findIndex(r => r.meta.changes === 0);

    if (failedIndex !== -1) {
        // تعويض: إرجاع الطلب لحالة "ملغى" + إعادة أي كمية خُصمت فعلاً بنجاح ضمن نفس هذه العملية قبل الفشل
        const compensation = [
            env.DB.prepare("UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").bind(orderId)
        ];
        orderItems.forEach((item, idx) => {
            if (decrementResults[idx].meta.changes > 0) {
                compensation.push(
                    item.variant_id
                        ? env.DB.prepare("UPDATE product_variants SET quantity = quantity + ? WHERE id = ?").bind(item.quantity, item.variant_id)
                        : env.DB.prepare("UPDATE products SET quantity = quantity + ? WHERE id = ?").bind(item.quantity, item.product_id)
                );
            }
        });
        await env.DB.batch(compensation);
        return jsonResponse({
            error: "تعذّرت إعادة تفعيل الطلب: نفدت كمية أحد المنتجات/التوليفات بالمخزون منذ إلغاء هذا الطلب"
        }, 409);
    }

    return jsonResponse({ message: "تمت إعادة تفعيل الطلب وخصم الكمية بنجاح" });
}
