// ============================================
// نقطة الدخول الرئيسية للـ Worker + التوجيه (Routing)
// ============================================
import { handleRegister, handleLogin } from "./vendors.js";
import { authenticateVendor, authenticateAdmin } from "./middleware.js";
import {
    handleAdminSetup, handleAdminLogin, handleListVendors, handleGetVendor,
    handleActivationQueue, handleActivateVendor, handleSuspendVendor, handleRejectPayment, handleSendPaymentReminder, handleExtendTrial,
    handleGetPendingActivationCount
} from "./admin.js";
import {
    handlePublicListVendors, handlePublicGetVendor, handlePublicListVendorProducts,
    handlePublicListProducts, handlePublicGetProduct
} from "./public.js";
import {
    handleCreateProduct, handleListProducts, handleGetProduct,
    handleUpdateProduct, handleDeleteProduct, handleAddProductImage, handleDeleteProductImage
} from "./products.js";
import { handleUploadImage } from "./upload.js";
import { handleSubmitPayment } from "./payments.js";
import {
    createNotification, handleListNotifications,
    handleMarkNotificationRead, handleMarkAllNotificationsRead
} from "./notifications.js";
import { handleListWilayas, handleListCommunes } from "./locations.js";
import { handleGetDeliveryRates, handleUpdateDeliveryRates } from "./delivery.js";
import { runScheduledChecks } from "./scheduled.js";
import { handleDashboardStats, handleGetVendorBadgeCounts } from "./dashboard.js";
import { handleGetSettings, handleUpdateSettings } from "./settings.js";
import {
    handleCreateOrder, handleTrackOrder, handleListVendorOrders,
    handleGetVendorOrder, handleUpdateOrderStatus
} from "./orders.js";

export default {
    async fetch(request, env, ctx) {
        // رؤوس CORS محسوبة لهذا الطلب تحديداً — تُقيَّد بنطاقات ALLOWED_ORIGINS (مفصولة بفاصلة بـwrangler.toml)
        // بدل "*" السابقة. لو Origin الطلب غير موجود بالقائمة، لا يُضاف رأس Allow-Origin إطلاقاً
        // (رفض افتراضي آمن — المتصفح نفسه يمنع الاستجابة حينها، حتى لو نسينا فحصاً يدوياً بمكان ما)
        const allowedOrigins = (env.ALLOWED_ORIGINS || "").split(",").map(o => o.trim()).filter(Boolean);
        const requestOrigin = request.headers.get("Origin");
        const CORS_HEADERS = {
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
        };
        if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
            CORS_HEADERS["Access-Control-Allow-Origin"] = requestOrigin;
        }

        // نفس اسم/توقيع الدالة القديمة تماماً — كل نقاط الاستدعاء الموجودة أسفل الملف (~50 موضع)
        // تستمر تعمل بدون أي تعديل عليها، لأنها تُغلق تلقائياً على CORS_HEADERS المحسوبة أعلاه لهذا الطلب
        function withCORS(response) {
            const newHeaders = new Headers(response.headers);
            Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
            return new Response(response.body, { status: response.status, headers: newHeaders });
        }

        // معالجة طلبات Preflight (CORS)
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        const { pathname } = url;

        try {
            // ---- مسارات عامة (بدون تسجيل دخول) ----
            if (pathname === "/api/vendors/register" && request.method === "POST") {
                return withCORS(await handleRegister(request, env));
            }
            if (pathname === "/api/vendors/login" && request.method === "POST") {
                return withCORS(await handleLogin(request, env));
            }

            // ---- مثال على مسار محمي (يتطلب تسجيل دخول التاجر) ----
            if (pathname === "/api/vendors/me" && request.method === "GET") {
                const auth = await authenticateVendor(request, env);
                if (!auth) {
                    return withCORS(new Response(
                        JSON.stringify({ error: "غير مصرّح. يرجى تسجيل الدخول." }),
                        { status: 401, headers: { "Content-Type": "application/json" } }
                    ));
                }
                const vendor = await env.DB.prepare(
                    "SELECT id, store_name, owner_name, email, status, trial_ends_at FROM vendors WHERE id = ?"
                ).bind(auth.vendor_id).first();
                return withCORS(new Response(JSON.stringify({ vendor }), {
                    headers: { "Content-Type": "application/json" }
                }));
            }

            // ---- مسارات المنتجات (كلها تتطلب تسجيل دخول التاجر) ----
            const productIdMatch = pathname.match(/^\/api\/products\/(\d+)$/);
            const productImagesMatch = pathname.match(/^\/api\/products\/(\d+)\/images$/);
            const productImageDeleteMatch = pathname.match(/^\/api\/products\/(\d+)\/images\/(\d+)$/);

            if (pathname === "/api/products" || productIdMatch || productImagesMatch || productImageDeleteMatch) {
                const auth = await authenticateVendor(request, env);
                if (!auth) {
                    return withCORS(new Response(
                        JSON.stringify({ error: "غير مصرّح. يرجى تسجيل الدخول." }),
                        { status: 401, headers: { "Content-Type": "application/json" } }
                    ));
                }

                if (pathname === "/api/products" && request.method === "POST") {
                    return withCORS(await handleCreateProduct(request, env, auth));
                }
                if (pathname === "/api/products" && request.method === "GET") {
                    return withCORS(await handleListProducts(request, env, auth));
                }
                if (productIdMatch && request.method === "GET") {
                    return withCORS(await handleGetProduct(request, env, auth, productIdMatch[1]));
                }
                if (productIdMatch && request.method === "PUT") {
                    return withCORS(await handleUpdateProduct(request, env, auth, productIdMatch[1]));
                }
                if (productIdMatch && request.method === "DELETE") {
                    return withCORS(await handleDeleteProduct(request, env, auth, productIdMatch[1]));
                }
                if (productImagesMatch && request.method === "POST") {
                    return withCORS(await handleAddProductImage(request, env, auth, productImagesMatch[1]));
                }
                if (productImageDeleteMatch && request.method === "DELETE") {
                    return withCORS(await handleDeleteProductImage(request, env, auth, productImageDeleteMatch[1], productImageDeleteMatch[2]));
                }
            }

            // ---- بيانات مرجعية عامة ----
            if (pathname === "/api/public/wilayas" && request.method === "GET") {
                return withCORS(await handleListWilayas(request, env));
            }
            if (pathname === "/api/public/communes" && request.method === "GET") {
                return withCORS(await handleListCommunes(request, env));
            }

            // ---- مسار إعدادات المتجر (محمي) ----
            if (pathname === "/api/vendor/settings") {
                const auth = await authenticateVendor(request, env);
                if (!auth) {
                    return withCORS(new Response(
                        JSON.stringify({ error: "غير مصرّح. يرجى تسجيل الدخول." }),
                        { status: 401, headers: { "Content-Type": "application/json" } }
                    ));
                }
                if (request.method === "GET") {
                    return withCORS(await handleGetSettings(request, env, auth));
                }
                if (request.method === "PUT") {
                    return withCORS(await handleUpdateSettings(request, env, auth));
                }
            }

            // ---- مسار أسعار التوصيل لكل تاجر (محمي) ----
            if (pathname === "/api/vendor/delivery-rates") {
                const auth = await authenticateVendor(request, env);
                if (!auth) {
                    return withCORS(new Response(
                        JSON.stringify({ error: "غير مصرّح. يرجى تسجيل الدخول." }),
                        { status: 401, headers: { "Content-Type": "application/json" } }
                    ));
                }
                if (request.method === "GET") {
                    return withCORS(await handleGetDeliveryRates(request, env, auth));
                }
                if (request.method === "PUT") {
                    return withCORS(await handleUpdateDeliveryRates(request, env, auth));
                }
            }

            // ---- مسار نظرة عامة التاجر (محمي) ----
            if (pathname === "/api/vendor/dashboard-stats" && request.method === "GET") {
                const auth = await authenticateVendor(request, env);
                if (!auth) {
                    return withCORS(new Response(
                        JSON.stringify({ error: "غير مصرّح. يرجى تسجيل الدخول." }),
                        { status: 401, headers: { "Content-Type": "application/json" } }
                    ));
                }
                return withCORS(await handleDashboardStats(request, env, auth));
            }

            // ---- مسار شارات السايدبار/الهيدر الموحّد (محمي) — استعلام واحد بدل مسارين منفصلين ----
            if (pathname === "/api/vendor/badges" && request.method === "GET") {
                const auth = await authenticateVendor(request, env);
                if (!auth) {
                    return withCORS(new Response(
                        JSON.stringify({ error: "غير مصرّح. يرجى تسجيل الدخول." }),
                        { status: 401, headers: { "Content-Type": "application/json" } }
                    ));
                }
                return withCORS(await handleGetVendorBadgeCounts(request, env, auth));
            }

            // ---- مسارات إشعارات التاجر (محمية) ----
            const notificationReadMatch = pathname.match(/^\/api\/vendor\/notifications\/(\d+)\/read$/);

            if (pathname === "/api/vendor/notifications" || notificationReadMatch || pathname === "/api/vendor/notifications/read-all") {
                const auth = await authenticateVendor(request, env);
                if (!auth) {
                    return withCORS(new Response(
                        JSON.stringify({ error: "غير مصرّح. يرجى تسجيل الدخول." }),
                        { status: 401, headers: { "Content-Type": "application/json" } }
                    ));
                }
                if (pathname === "/api/vendor/notifications" && request.method === "GET") {
                    return withCORS(await handleListNotifications(request, env, auth));
                }
                if (notificationReadMatch && request.method === "PUT") {
                    return withCORS(await handleMarkNotificationRead(request, env, auth, notificationReadMatch[1]));
                }
                if (pathname === "/api/vendor/notifications/read-all" && request.method === "PUT") {
                    return withCORS(await handleMarkAllNotificationsRead(request, env, auth));
                }
            }

            // ---- مسارات رفع الصور وإرسال الدفع (تتطلب تسجيل دخول التاجر) ----
            if (pathname === "/api/vendors/upload-image" && request.method === "POST") {
                const auth = await authenticateVendor(request, env);
                if (!auth) {
                    return withCORS(new Response(
                        JSON.stringify({ error: "غير مصرّح. يرجى تسجيل الدخول." }),
                        { status: 401, headers: { "Content-Type": "application/json" } }
                    ));
                }
                return withCORS(await handleUploadImage(request, env, auth));
            }
            if (pathname === "/api/vendors/payments" && request.method === "POST") {
                const auth = await authenticateVendor(request, env);
                if (!auth) {
                    return withCORS(new Response(
                        JSON.stringify({ error: "غير مصرّح. يرجى تسجيل الدخول." }),
                        { status: 401, headers: { "Content-Type": "application/json" } }
                    ));
                }
                return withCORS(await handleSubmitPayment(request, env, auth));
            }

            // ---- مسارات الطلبات العامة (بدون تسجيل دخول - Guest) ----
            if (pathname === "/api/orders" && request.method === "POST") {
                return withCORS(await handleCreateOrder(request, env));
            }
            if (pathname === "/api/orders/track" && request.method === "GET") {
                return withCORS(await handleTrackOrder(request, env));
            }

            // ---- مسارات إدارة الطلبات من جهة التاجر (محمية) ----
            const vendorOrderIdMatch = pathname.match(/^\/api\/vendor\/orders\/(\d+)$/);
            const vendorOrderStatusMatch = pathname.match(/^\/api\/vendor\/orders\/(\d+)\/status$/);

            if (pathname === "/api/vendor/orders" || vendorOrderIdMatch || vendorOrderStatusMatch) {
                const auth = await authenticateVendor(request, env);
                if (!auth) {
                    return withCORS(new Response(
                        JSON.stringify({ error: "غير مصرّح. يرجى تسجيل الدخول." }),
                        { status: 401, headers: { "Content-Type": "application/json" } }
                    ));
                }

                if (pathname === "/api/vendor/orders" && request.method === "GET") {
                    return withCORS(await handleListVendorOrders(request, env, auth));
                }
                if (vendorOrderIdMatch && request.method === "GET") {
                    return withCORS(await handleGetVendorOrder(request, env, auth, vendorOrderIdMatch[1]));
                }
                if (vendorOrderStatusMatch && request.method === "PUT") {
                    return withCORS(await handleUpdateOrderStatus(request, env, auth, vendorOrderStatusMatch[1]));
                }
            }

            // ---- مسارات التصفح العامة (بدون تسجيل دخول) ----
            const publicVendorIdMatch = pathname.match(/^\/api\/public\/vendors\/([^/]+)$/);
            const publicVendorProductsMatch = pathname.match(/^\/api\/public\/vendors\/([^/]+)\/products$/);
            const publicProductIdMatch = pathname.match(/^\/api\/public\/products\/(\d+)$/);

            if (pathname === "/api/public/vendors" && request.method === "GET") {
                return withCORS(await handlePublicListVendors(request, env));
            }
            if (publicVendorIdMatch && request.method === "GET") {
                return withCORS(await handlePublicGetVendor(request, env, decodeURIComponent(publicVendorIdMatch[1])));
            }
            if (publicVendorProductsMatch && request.method === "GET") {
                return withCORS(await handlePublicListVendorProducts(request, env, decodeURIComponent(publicVendorProductsMatch[1])));
            }
            if (pathname === "/api/public/products" && request.method === "GET") {
                return withCORS(await handlePublicListProducts(request, env));
            }
            if (publicProductIdMatch && request.method === "GET") {
                return withCORS(await handlePublicGetProduct(request, env, publicProductIdMatch[1]));
            }

            // ---- مسارات المشرف العامة (بدون تسجيل دخول) ----
            if (pathname === "/api/admin/setup" && request.method === "POST") {
                return withCORS(await handleAdminSetup(request, env));
            }
            if (pathname === "/api/admin/login" && request.method === "POST") {
                return withCORS(await handleAdminLogin(request, env));
            }

            // ---- مسارات المشرف المحمية ----
            const adminVendorIdMatch = pathname.match(/^\/api\/admin\/vendors\/(\d+)$/);
            const adminActivateMatch = pathname.match(/^\/api\/admin\/vendors\/(\d+)\/activate$/);
            const adminSuspendMatch = pathname.match(/^\/api\/admin\/vendors\/(\d+)\/suspend$/);
            const adminRejectPaymentMatch = pathname.match(/^\/api\/admin\/vendors\/(\d+)\/reject-payment$/);
            const adminRemindMatch = pathname.match(/^\/api\/admin\/vendors\/(\d+)\/remind$/);
            const adminExtendTrialMatch = pathname.match(/^\/api\/admin\/vendors\/(\d+)\/extend-trial$/);
            const adminPendingCountMatch = pathname === "/api/admin/vendors/pending-count";

            const isAdminRoute = pathname === "/api/admin/vendors" || pathname === "/api/admin/activation-queue"
                || adminVendorIdMatch || adminActivateMatch || adminSuspendMatch || adminRejectPaymentMatch || adminRemindMatch || adminExtendTrialMatch
                || adminPendingCountMatch;

            if (isAdminRoute) {
                const auth = await authenticateAdmin(request, env);
                if (!auth) {
                    return withCORS(new Response(
                        JSON.stringify({ error: "غير مصرّح. يرجى تسجيل دخول المشرف." }),
                        { status: 401, headers: { "Content-Type": "application/json" } }
                    ));
                }

                if (pathname === "/api/admin/vendors" && request.method === "GET") {
                    return withCORS(await handleListVendors(request, env));
                }
                if (pathname === "/api/admin/activation-queue" && request.method === "GET") {
                    return withCORS(await handleActivationQueue(request, env));
                }
                if (adminPendingCountMatch && request.method === "GET") {
                    return withCORS(await handleGetPendingActivationCount(request, env));
                }
                if (adminVendorIdMatch && request.method === "GET") {
                    return withCORS(await handleGetVendor(request, env, adminVendorIdMatch[1]));
                }
                if (adminActivateMatch && request.method === "PUT") {
                    return withCORS(await handleActivateVendor(request, env, adminActivateMatch[1]));
                }
                if (adminSuspendMatch && request.method === "PUT") {
                    return withCORS(await handleSuspendVendor(request, env, adminSuspendMatch[1]));
                }
                if (adminRejectPaymentMatch && request.method === "PUT") {
                    return withCORS(await handleRejectPayment(request, env, adminRejectPaymentMatch[1]));
                }
                if (adminRemindMatch && request.method === "PUT") {
                    return withCORS(await handleSendPaymentReminder(request, env, adminRemindMatch[1]));
                }
                if (adminExtendTrialMatch && request.method === "PUT") {
                    return withCORS(await handleExtendTrial(request, env, adminExtendTrialMatch[1]));
                }
            }

            // مسار غير معروف
            return withCORS(new Response(
                JSON.stringify({ error: "المسار غير موجود" }),
                { status: 404, headers: { "Content-Type": "application/json" } }
            ));

        } catch (err) {
            // لا نُظهر تفاصيل الخطأ الداخلي للمستخدم (تسريب معلومات = ثغرة أمنية)
            console.error("Unhandled error:", err);
            return withCORS(new Response(
                JSON.stringify({ error: "حدث خطأ غير متوقع في الخادم" }),
                { status: 500, headers: { "Content-Type": "application/json" } }
            ));
        }
    },

    // يُستدعى تلقائياً من Cloudflare حسب الجدولة المحددة بـ wrangler.toml (crons)
    async scheduled(event, env, ctx) {
        try {
            const result = await runScheduledChecks(env);
            console.log("Scheduled checks completed:", JSON.stringify(result));
        } catch (err) {
            console.error("Scheduled task failed:", err);
        }
    }
};
