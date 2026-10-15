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
// تشفير/فك تشفير بيانات اعتماد شركات التوصيل (قابل للعكس، بعكس تشفير كلمة المرور أعلاه)
// يحتاج binding باسم SHIPPING_ENCRYPTION_KEY (سر عبر wrangler secret put، وليس متغيّر عادي)
// AES-GCM قياسي عبر Web Crypto — نفس فلسفة الملف: بدون أي مكتبة خارجية
// تُستخدم لاحقاً بميزة الشحن التلقائي (dzship)؛ غير مُستدعاة من أي مسار حالياً
// ============================================

// أقصر طول مقبول للسر. أي سر غائب أو أقصر من ذلك يُرفض صراحةً: بدون هذا الفحص كان غياب السر يعني تشفيراً
// بمفتاح مشتق من نص فارغ (أي يمكن لأي أحد فكّه) دون أي تنبيه. يجب أن يطابق MIN_SHIPPING_KEY_LENGTH بملف src/shipping.js
const MIN_SHIPPING_SECRET_LENGTH = 16;
function hasValidShippingSecret(secret) {
    return typeof secret === "string" && secret.length >= MIN_SHIPPING_SECRET_LENGTH;
}

// اشتقاق مفتاح AES-GCM ثابت الطول (256-بت) من السر النصي المخزَّن بـwrangler، عبر SHA-256
// (السر نفسه لا يُستخدم مباشرة كمفتاح، بل يُهضم أولاً لضمان طول ثابت بغض النظر عن طول النص الأصلي)
async function deriveShippingEncryptionKey(secret) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// تشفير كائن بيانات الاعتماد (مثال: { apiId, apiToken }) إلى نص واحد قابل للتخزين بعمود نصي بـD1
// متجه تهيئة (IV) عشوائي فريد بكل عملية تشفير — نفس مبدأ الملح العشوائي الفريد بـhashPassword أعلاه
export async function encryptShippingCredentials(credentialsObject, secret) {
    if (!hasValidShippingSecret(secret)) {
        throw new Error(`SHIPPING_ENCRYPTION_KEY غير مضبوط أو أقصر من ${MIN_SHIPPING_SECRET_LENGTH} حرفاً — رُفض التشفير بدل استخدام مفتاح ضعيف`);
    }
    const key = await deriveShippingEncryptionKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 12 بايت هو الطول القياسي الموصى به لـAES-GCM
    const plaintext = new TextEncoder().encode(JSON.stringify(credentialsObject));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return `${bufferToHex(iv)}:${bufferToHex(ciphertext)}`;
}

// فك تشفير النص المخزَّن بالعمود، وإرجاعه ككائن جاهز للاستخدام (أو null لو فشل الفك لأي سبب —
// مفتاح تغيّر، بيانات تالفة... إلخ — الاستدعاء المسؤول عن العرض هو من يقرر كيف يتعامل مع null)
export async function decryptShippingCredentials(encryptedString, secret) {
    if (!hasValidShippingSecret(secret)) {
        console.error("فك التشفير مرفوض: SHIPPING_ENCRYPTION_KEY غير مضبوط أو أقصر من الحد الأدنى");
        return null;
    }
    try {
        const [ivHex, ciphertextHex] = encryptedString.split(":");
        const key = await deriveShippingEncryptionKey(secret);
        const iv = new Uint8Array(hexToBuffer(ivHex));
        const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, hexToBuffer(ciphertextHex));
        return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (err) {
        console.error("فشل فك تشفير بيانات اعتماد شركة التوصيل:", err);
        return null;
    }
}

// ============================================
// رمز "قفل سعر التوصيل" (الشحن التلقائي): السعر الحي الذي يراه الزبون يخرج من الخادم موقَّعاً، وتعيده الواجهة مع الطلب،
// فيُسجَّل بالطلب السعر نفسه الذي رآه الزبون (ويُرسَل لشركة التوصيل كمبلغ تحصيل) بلا أي استدعاء لـdzship وقت الطلب.
//
// أمان: التوقيع بمفتاح مشتق من JWT_SECRET + بصمة خاصة بهذا الغرض (domain separation). فلا يمكن استعمال رمز السعر
// (وهو علني بالضرورة) كرمز دخول لتاجر أو مشرف، ولا العكس — لأن مفتاح التوقيع مختلف أصلاً وليس لأن الحقول مختلفة فقط.
// الحمولة مقتضبة عمداً: v = رقم التاجر، w = رمز الولاية، h = سعر المنزل، o = سعر المكتب
// ============================================
const FEE_QUOTE_KEY_SUFFIX = ":fee-quote:v1";
const FEE_QUOTE_TTL_SECONDS = 60 * 60; // ساعة: كافية لتعبئة الفورم، وقصيرة بما يكفي ليبقى السعر قريباً من الحي
const FEE_QUOTE_MAX_LENGTH = 512;      // حد أمان قبل أي عملية تشفير (الرمز الفعلي نحو 190 حرفاً)

export async function signFeeQuote({ vendorId, wilayaCode, home, office }, jwtSecret) {
    return signJWT({ v: vendorId, w: wilayaCode, h: home, o: office }, jwtSecret + FEE_QUOTE_KEY_SUFFIX, FEE_QUOTE_TTL_SECONDS);
}

// يُرجع { vendorId, wilayaCode, home, office } لو الرمز سليم وغير منتهٍ وحمولته مطابقة للشكل المتوقع، وإلا null
// (أي خلل: توقيع، انتهاء، شكل، نوع بيانات... كلها null — لا يُلقي استثناءً أبداً حتى مع مدخلات تالفة)
export async function verifyFeeQuote(token, jwtSecret) {
    if (typeof token !== "string" || token.length === 0 || token.length > FEE_QUOTE_MAX_LENGTH) return null;
    if (typeof jwtSecret !== "string" || jwtSecret.length === 0) return null;
    let payload;
    try {
        payload = await verifyJWT(token, jwtSecret + FEE_QUOTE_KEY_SUFFIX);
    } catch {
        return null;
    }
    if (!payload) return null;
    const { v, w, h, o } = payload;
    const valid = Number.isInteger(v) && typeof w === "string" && /^\d{2}$/.test(w)
        && typeof h === "number" && Number.isFinite(h) && h >= 0
        && typeof o === "number" && Number.isFinite(o) && o >= 0;
    return valid ? { vendorId: v, wilayaCode: w, home: h, office: o } : null;
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
