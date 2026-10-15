// ============================================
// وسيط التحقق من الهوية (Middleware)
// يُستخدم لحماية أي مسار يتطلب تسجيل دخول التاجر
// ============================================
import { verifyJWT } from "./security.js";

// يتحقق من رأس Authorization: Bearer <token>
// يرجع بيانات التاجر (vendor_id) إذا كان الرمز صالحاً، أو null إذا لم يكن
export async function authenticateVendor(request, env) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return null;
    }
    const token = authHeader.slice(7);
    const payload = await verifyJWT(token, env.JWT_SECRET);
    if (!payload || !payload.vendor_id) return null;
    return payload;
}

// يتحقق من رأس Authorization: Bearer <token> لمسارات المشرف
export async function authenticateAdmin(request, env) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return null;
    }
    const token = authHeader.slice(7);
    const payload = await verifyJWT(token, env.JWT_SECRET);
    if (!payload || !payload.admin_id) return null;
    return payload;
}
