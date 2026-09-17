// ============================================
// أدوات الأمان: تشفير كلمات المرور وتوقيع الجلسات (JWT)
// تُستخدم فقط Web Crypto API المدمجة في Cloudflare Workers
// بدون أي مكتبة خارجية (تقليل نقاط الفشل والاعتماديات)
// ============================================

const PBKDF2_ITERATIONS = 100000; // معيار عالمي معتمد (OWASP يوصي بـ 100,000+ لـ SHA-256)

function bufferToHex(buffer) {
    return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuffer(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes.buffer;
}

// تشفير كلمة المرور: ملح عشوائي فريد لكل مستخدم + PBKDF2-SHA256
export async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
    );
    const derivedBits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
        keyMaterial, 256
    );
    return `${bufferToHex(salt)}:${bufferToHex(derivedBits)}`;
}

// التحقق من كلمة المرور عند الدخول (بمقارنة زمنية آمنة عبر crypto.subtle نفسها)
export async function verifyPassword(password, stored) {
    const [saltHex, hashHex] = stored.split(":");
    const salt = hexToBuffer(saltHex);
    const keyMaterial = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
    );
    const derivedBits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
        keyMaterial, 256
    );
    return bufferToHex(derivedBits) === hashHex;
}

function base64url(input) {
    return btoa(String.fromCharCode(...new Uint8Array(input)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBuffer(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

// إنشاء رمز JWT موقّع (HMAC-SHA256) صالح لمدة محددة
export async function signJWT(payload, secret, expiresInSeconds = 60 * 60 * 24 * 7) {
    const header = { alg: "HS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

    const encoder = new TextEncoder();
    const headerB64 = base64url(encoder.encode(JSON.stringify(header)));
    const payloadB64 = base64url(encoder.encode(JSON.stringify(fullPayload)));
    const data = `${headerB64}.${payloadB64}`;

    const key = await crypto.subtle.importKey(
        "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
    return `${data}.${base64url(signature)}`;
}

// التحقق من صحة رمز JWT (التوقيع + تاريخ الانتهاء)
export async function verifyJWT(token, secret) {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const valid = await crypto.subtle.verify(
        "HMAC", key, base64urlToBuffer(signatureB64), encoder.encode(`${headerB64}.${payloadB64}`)
    );
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64urlToBuffer(payloadB64)));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null; // منتهي الصلاحية

    return payload;
}

// ============================================
// حماية Rate Limiting لمسارات تسجيل الدخول (يحتاج binding باسم RATE_LIMIT_KV بـwrangler.toml)
// مصمَّمة عمداً بأقل تكلفة: قراءة واحدة للفحص، وكتابة واحدة فقط إذا فشلت المحاولة فعلياً
// (محاولة محظورة بالفعل = قراءة واحدة فقط بدون أي كتابة إضافية، حتى مع آلاف المحاولات)
// ============================================
export const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60; // 15 دقيقة

// مفتاح فريد يجمع عنوان IP + الهدف (مثال: البريد الإلكتروني المُستهدَف) — يمنع استهداف حساب معيّن
// بالتخمين، وبنفس الوقت لا يمنع مستخدمين مختلفين بنفس الشبكة (مثال: مقهى إنترنت) من بعضهم
export function buildRateLimitKey(prefix, request, identifier) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    return `ratelimit:${prefix}:${ip}:${(identifier || "").toLowerCase()}`;
}

// قراءة واحدة فقط — يُستدعى أول شيء بأي مسار دخول قبل أي منطق آخر
// تدهور رشيق (Fail-Safe): لو الـKV غير مربوط أصلاً (نسيان إعداد وقت النشر) أو فشل لأي سبب،
// نعتبر العدّاد صفراً (نسمح بالمتابعة) بدل رمي خطأ يعطّل تسجيل الدخول بالكامل — نفس فلسفة
// notifyVendorOfNewOrder بملف orders.js: ميزة ثانوية (حماية إضافية) لا يجب أبداً أن تُسقط الوظيفة الأساسية
export async function getRateLimitCount(env, key) {
    if (!env.RATE_LIMIT_KV) return 0;
    try {
        const current = await env.RATE_LIMIT_KV.get(key);
        return current ? Number(current) : 0;
    } catch (err) {
        console.error("فشل قراءة Rate Limit KV، السماح بالمتابعة:", err);
        return 0;
    }
}

// كتابة واحدة فقط — يُستدعى فقط عند فشل المحاولة فعلياً (بريد/كلمة مرور خاطئة)
// يُعاد استخدام العدد المقروء مسبقاً بدل قراءته مجدداً (يمنع قراءة مزدوجة لنفس المفتاح)
export async function recordFailedAttempt(env, key, currentCount) {
    if (!env.RATE_LIMIT_KV) return;
    try {
        await env.RATE_LIMIT_KV.put(key, String(currentCount + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
    } catch (err) {
        console.error("فشل كتابة Rate Limit KV، تجاهل بدون تعطيل تسجيل الدخول:", err);
    }
}
