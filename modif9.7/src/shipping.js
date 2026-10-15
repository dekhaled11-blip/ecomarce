// ============================================
// طبقة العزل الوحيدة للتعامل مع dzship (بوابة شركات التوصيل الجزائرية) — https://freeship.dzbuild.com
// أي ملف آخر بالمشروع لا يتكلم مع dzship مباشرة أبداً: لو تغيّرت البوابة أو استُبدلت لاحقاً، يتغيّر هذا الملف وحده.
//
// قواعد صارمة يلتزم بها هذا الملف:
// 1. لا يلمس D1 ولا KV إطلاقاً (منطق بحت). الكاش الوحيد المستخدم هنا هو كاش حافة Cloudflare
//    للبيانات المرجعية (قوائم ثابتة تتغيّر بضع مرات بالسنة) — بدون أي كتابة على KV.
// 2. لا يكتب بيانات اعتماد التاجر (credentials) بأي سجل أو رسالة خطأ، مهما كان السبب.
// 3. كل فشل يُرجَع كـShippingError موحّد فيه: رسالة عربية جاهزة للعرض، وهل تستحق إعادة المحاولة،
//    وهل الشحنة "قد تكون أُنشئت فعلاً" (حالة الغموض) — كي لا تُنشأ شحنة مكررة بالخطأ.
// ============================================

const DZSHIP_BASE_URL = "https://freeship.dzbuild.com";

// مهلة dzship نفسها بالاتصال بشركة التوصيل (تُرسَل ضمن options.timeoutMs)، ومهلتنا نحن أطول منها بقليل
// عمداً: كي تصلنا رسالة الفشل منها بدل أن نقطع الاتصال قبلها ونقع بحالة الغموض دون داعٍ
const DZSHIP_TIMEOUT_MS = 20000;
const CLIENT_TIMEOUT_MS = 25000;

// البيانات المرجعية (الشركات/البلديات) ثابتة تقريباً — كاش حافة يوم كامل (توصية dzship نفسها بتوثيقها)
const REFERENCE_CACHE_SECONDS = 86400;

// كاش داخل نفس نسخة الـWorker للبلديات (58 ولاية بحد أقصى) — يوفّر الاستدعاء الخارجي المتكرر
// ضمن نفس التشغيل/الدفعة، وهو مهم لأن لكل تشغيل حداً أقصى لعدد الاستدعاءات الخارجية
const COMMUNES_ISOLATE_TTL_MS = 6 * 60 * 60 * 1000;
const communesIsolateCache = new Map(); // wilayaCode -> { at, list }

// سقف منطقي لعدد بلديات الولاية الواحدة (أكبر ولاية نحو 67 بلدية). قائمة أكبر من ذلك تعني أن الفلترة بالولاية لم تعمل
// (مثلاً أُعيدت كل بلديات الجزائر الـ1541)، فنرفضها بدل أن نطابق بلدية الزبون على بلديات ولايات أخرى بصمت
const MAX_COMMUNES_PER_WILAYA = 150;

// أقصر طول مقبول لسر التشفير — يجب أن يطابق MIN_SHIPPING_SECRET_LENGTH بملف src/security.js
const MIN_SHIPPING_KEY_LENGTH = 16;

// هل الخادم مهيّأ فعلاً للشحن التلقائي؟ شرطان معاً: سر تشفير صالح (SHIPPING_ENCRYPTION_KEY) + مساحة KV للكاش (SHIPPING_CACHE_KV).
// لا تلمس أي منهما: تفحص وجودهما فقط. إن غاب أحدهما يُغلق الشحن التلقائي كلياً (لا ربط، لا طابور، لا سعر حي)
// ويبقى الوضع اليدوي يعمل كما هو — بدل أن يعمل جزئياً بتشفير ضعيف أو يستهلك الحد المشترك لدى dzship بلا كاش
export function isShippingConfigured(env) {
    const key = env && env.SHIPPING_ENCRYPTION_KEY;
    const kv = env && env.SHIPPING_CACHE_KV;
    return typeof key === "string" && key.length >= MIN_SHIPPING_KEY_LENGTH &&
        !!kv && typeof kv.get === "function" && typeof kv.put === "function";
}

// الشركات الأشهر بالسوق الجزائري — تُعرض أولاً بواجهة التاجر، والباقي (99 شركة) يُبحث عنه بالاسم
export const FEATURED_COURIER_KEYS = ["yalidine", "zrexpress", "maystro", "noest", "zimou"];

// المفردات الموحّدة لحالة الشحنة (14 حالة) حسب توثيق dzship
// الحالات النهائية: لا يوجد بعدها أي تغيّر، فيتوقف الفحص الدوري عندها تماماً
export const TERMINAL_SHIPPING_STATUSES = ["delivered", "returned", "cancelled", "lost"];

// ============================================
// التوصيل لمكتب (stopdesk): لكل شركة طريقتها — من الجدول الرسمي بوثيقة dzship ("Stop desks"):
//   • desk_id: تُوجَّه الطرد بمعرّف المكتب (stopDeskId من POST /v1/desks) — عائلة Yalidine وNOEST وZR الجديدة وZimou وEcom وMDM وNear.
//             (Yalidine وعائلتها تريد أيضاً بلدية المكتب نفسه بدل بلدية الزبون)
//   • commune: لا معرّف مكتب؛ يُوجَّه الطرد لمكتب بلدية الزبون نفسها — كل شركات Ecotrack وMaystro وElogistia.
//   • unsupported: لا قائمة مكاتب عبر واجهتها (422 NOT_SUPPORTED) — ZR Express (Procolis) ومرادفاتها وColivraison.
// Near Delivery نقاط استلام فقط: لا توصيل للمنزل. أي مفتاح غير مذكور (مثل أي شركة من 82 شركة Ecotrack) = commune افتراضياً.
// ============================================
const DESK_ID_COURIERS = new Set([
    "yalidine", "yalitec", "guepex", "easyandspeed", "economiqua", "wecan",
    "noest", "zrexpressnew", "zimou", "ecomdelivery", "mdm", "neardelivery", "sandbox"
]);
const OFFICE_UNSUPPORTED_COURIERS = new Set(["zrexpress", "abexexpress", "leopardexpress", "colilog", "flashdelivery", "colivraison"]);
const HOME_UNSUPPORTED_COURIERS = new Set(["neardelivery"]);

// ما تدعمه شركة التاجر المربوطة: { home: true|false, office: "desk_id" | "commune" | "unsupported" } — دالة نقية بلا أي كلفة
export function getCourierShippingSupport(courier) {
    return {
        home: !HOME_UNSUPPORTED_COURIERS.has(courier),
        office: DESK_ID_COURIERS.has(courier) ? "desk_id" : OFFICE_UNSUPPORTED_COURIERS.has(courier) ? "unsupported" : "commune"
    };
}

// تسميات عربية للعرض (ترجمتي أنا؛ لم يوفّر التوثيق المرفق نصوصاً عربية جاهزة)
export const SHIPPING_STATUS_LABELS_AR = {
    created: "تم إنشاء الشحنة",
    pending_pickup: "بانتظار استلامها من المتجر",
    picked_up: "تم استلامها من المتجر",
    in_transit: "في الطريق",
    at_hub: "وصلت مركز الفرز",
    out_for_delivery: "خرجت للتسليم",
    delivered: "تم التسليم",
    delivery_attempted: "محاولة تسليم لم تنجح",
    on_hold: "معلّقة مؤقتاً",
    return_in_transit: "في طريق الإرجاع",
    returned: "تم إرجاعها",
    cancelled: "أُلغيت",
    lost: "فُقدت",
    unknown: "حالة غير معروفة"
};

// ============================================
// الأخطاء الموحّدة
// ============================================

// رسائل عربية جاهزة للتاجر حسب رمز الخطأ — لا رموز تقنية خام تظهر له أبداً
const ERROR_MESSAGES_AR = {
    VALIDATION_ERROR: "بيانات الشحنة غير مكتملة أو غير صالحة",
    invalid_phone: "رقم هاتف الزبون غير صالح — تواصل معه لتصحيح الرقم",
    NOT_SUPPORTED: "هذه العملية غير مدعومة لدى شركة التوصيل المختارة",
    COURIER_ERROR: "رفضت شركة التوصيل الطلب أو تعذّر الوصول إليها",
    EGRESS_BLOCKED: "عنوان شركة التوصيل غير مسموح به",
    rate_limited: "تم تجاوز الحد المسموح من الطلبات مؤقتاً — ستُعاد المحاولة تلقائياً",
    overloaded: "الخدمة مشغولة لحظياً — ستُعاد المحاولة تلقائياً",
    TIMEOUT: "استغرق الاتصال بشركة التوصيل وقتاً أطول من المسموح",
    NETWORK_ERROR: "تعذّر الاتصال بخدمة الشحن حالياً",
    INVALID_RESPONSE: "ردّت خدمة الشحن بشكل غير متوقع",
    MISSING_CREDENTIALS: "بيانات حساب شركة التوصيل غير مكتملة — راجع إعدادات الشحن",
    LOCAL_VALIDATION: "بيانات الطلب غير صالحة للشحن",
    COMMUNE_NOT_FOUND: "تعذّرت مطابقة البلدية مع قائمة شركة التوصيل",
    COMMUNE_AMBIGUOUS: "اسم البلدية يطابق أكثر من بلدية بقائمة شركة التوصيل",
    DESK_LIST_UNAVAILABLE: "تعذّر جلب قائمة مكاتب الشركة الآن — أعد المحاولة بعد دقيقة"
};

export class ShippingError extends Error {
    constructor(code, message, { httpStatus = 0, retryable = false, retryAfter = null, fields = null, ambiguous = false } = {}) {
        super(message || ERROR_MESSAGES_AR[code] || "حدث خطأ أثناء التعامل مع خدمة الشحن");
        this.name = "ShippingError";
        this.code = code;
        this.httpStatus = httpStatus;
        // هل تستحق إعادة المحاولة تلقائياً لاحقاً (فشل مؤقت لا علاقة له ببيانات الطلب نفسها)
        this.retryable = retryable;
        this.retryAfter = retryAfter; // بالثواني، لو أرسلت البوابة Retry-After
        this.fields = fields;         // تفاصيل الحقول الخاطئة (VALIDATION_ERROR) لو وُجدت
        // حالة الغموض: الطلب أُرسل ولم نتأكد هل أُنشئت الشحنة فعلاً (مهلة/رد تالف بعد الإرسال).
        // إعادة المحاولة الآلية هنا قد تصنع شحنة مكررة، لذلك لا تُعاد آلياً — يتحقق التاجر بنفسه
        this.ambiguous = ambiguous;
    }
}

// تنظيف نص رسالة قادم من طرف خارجي قبل عرضه (يُقصّ طوله ويُزال أي محرف تحكّم) —
// ومع ذلك يجب على الواجهة الأمامية عرضه دائماً عبر escapeHtml كأي نص خارجي
function cleanUpstreamText(text, max = 300) {
    if (typeof text !== "string") return "";
    return text.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);
}

// إزالة أي قيمة من بيانات اعتماد التاجر لو ردّتها شركة توصيل ضمن رسالة خطأ (مثل "Invalid token abc123")
// حتى لا تظهر للتاجر ولا تُخزَّن في آخر رسالة خطأ بقاعدة البيانات
function scrubSecrets(text, secrets) {
    let out = text;
    for (const secret of secrets) {
        if (typeof secret === "string" && secret.length >= 4) out = out.split(secret).join("***");
    }
    return out;
}

function parseRetryAfter(headerValue) {
    const seconds = parseInt(headerValue, 10);
    if (!Number.isFinite(seconds) || seconds < 0) return 60; // قيمة معقولة لو غاب الرأس أو تلف
    return Math.min(seconds, 3600);
}

// ============================================
// نواة الاتصال — كل استدعاءات dzship تمر من هنا فقط
// ============================================

// mayHaveSideEffects: true لعمليات الإنشاء (تُنشئ شحنة فعلية) — تُفعّل معالجة حالة الغموض
// cacheable: true للبيانات المرجعية GET فقط — تُخزَّن بكاش حافة Cloudflare (لا KV ولا D1)
async function dzshipRequest(path, { method = "GET", body = null, cacheable = false, mayHaveSideEffects = false, secrets = [], timeoutMs = CLIENT_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    let rawText;
    try {
        const init = { method, headers: { "Accept": "application/json" }, signal: controller.signal };
        if (body !== null) {
            init.headers["Content-Type"] = "application/json";
            init.body = JSON.stringify(body);
        }
        if (cacheable) {
            init.cf = { cacheTtl: REFERENCE_CACHE_SECONDS, cacheEverything: true };
        }
        response = await fetch(`${DZSHIP_BASE_URL}${path}`, init);
        // قراءة الجسم ضمن نفس المهلة (رد يتعلّق أثناء التحميل يجب ألا يعلّق العملية للأبد)
        rawText = await response.text();
    } catch (err) {
        const timedOut = err && err.name === "AbortError";
        // مهلة على عملية إنشاء = غموض (ربما وصل الطلب وأُنشئت الشحنة) → لا إعادة آلية.
        // فشل شبكة فوري (رفض اتصال/DNS) = الطلب على الأغلب لم يصل → آمن للإعادة
        throw new ShippingError(timedOut ? "TIMEOUT" : "NETWORK_ERROR", null, {
            retryable: !(timedOut && mayHaveSideEffects),
            ambiguous: timedOut && mayHaveSideEffects
        });
    } finally {
        clearTimeout(timer);
    }

    let data = null;
    try {
        data = rawText ? JSON.parse(rawText) : null;
    } catch {
        data = null; // صفحة HTML من بوابة وسيطة مثلاً — نعامله كرد غير متوقع أدناه
    }

    if (!response.ok) {
        throw errorFromHttpResponse(response, data, mayHaveSideEffects, secrets);
    }
    if (data === null || typeof data !== "object") {
        // رد ناجح الحالة لكن بلا محتوى صالح: على عملية الإنشاء قد تكون الشحنة أُنشئت فعلاً
        throw new ShippingError("INVALID_RESPONSE", null, { httpStatus: response.status, ambiguous: mayHaveSideEffects, retryable: !mayHaveSideEffects });
    }
    return data;
}

function errorFromHttpResponse(response, data, mayHaveSideEffects, secrets) {
    const status = response.status;
    const envelope = data && typeof data === "object" && data.error && typeof data.error === "object" ? data.error : {};
    const code = typeof envelope.code === "string" && envelope.code ? envelope.code : `HTTP_${status}`;
    const upstreamMessage = scrubSecrets(cleanUpstreamText(envelope.message), secrets);
    let fields = null;
    if (envelope.fields && typeof envelope.fields === "object") {
        fields = {};
        for (const [key, value] of Object.entries(envelope.fields).slice(0, 20)) {
            fields[String(key).slice(0, 60)] = scrubSecrets(cleanUpstreamText(value, 200), secrets);
        }
    }

    // 429 و503 و502 موثّقة بأنها رفض/إشغال قبل إنشاء أي شيء → آمنة للإعادة
    if (status === 429) {
        return new ShippingError(code, ERROR_MESSAGES_AR[code] || ERROR_MESSAGES_AR.rate_limited, {
            httpStatus: status, retryable: true, retryAfter: parseRetryAfter(response.headers.get("retry-after"))
        });
    }
    if (status === 503) {
        return new ShippingError(code, ERROR_MESSAGES_AR[code] || ERROR_MESSAGES_AR.overloaded, { httpStatus: status, retryable: true, retryAfter: 30 });
    }
    if (status === 502) {
        const base = ERROR_MESSAGES_AR[code] || ERROR_MESSAGES_AR.COURIER_ERROR;
        return new ShippingError(code, upstreamMessage ? `${base}: ${upstreamMessage}` : base, { httpStatus: status, retryable: true, fields });
    }

    // أخطاء الخادم غير الموثّقة (500، 504، 52x من كلاودفلير): على عملية الإنشاء لا نعرف هل وصل الطلب
    if (status >= 500) {
        return new ShippingError(code, null, {
            httpStatus: status, retryable: !mayHaveSideEffects, ambiguous: mayHaveSideEffects
        });
    }

    // أخطاء 4xx (بيانات خاطئة، شركة رفضت الطلب...) — إعادة المحاولة بنفس البيانات لن تفيد أبداً
    const base = ERROR_MESSAGES_AR[code] || ERROR_MESSAGES_AR.COURIER_ERROR;
    const message = upstreamMessage && code !== "invalid_phone" ? `${base}: ${upstreamMessage}` : base;
    return new ShippingError(code, message, { httpStatus: status, retryable: false, fields });
}

// ============================================
// التحقق المحلي (قبل أي استدعاء) — كل طلب مرفوض من dzship يستهلك من الحد المشترك للموقع كله،
// فأي خطأ نكتشفه محلياً بدون إرسال يوفّر من هذا الحد ويعطي التاجر رسالة أوضح وأسرع
// ============================================

// تطبيع رقم الجوال الجزائري لصيغة 0XXXXXXXXX (05/06/07 + 8 أرقام) — يقبل +213 و00213 والمسافات والأرقام العربية
// يرجع null لو الرقم ليس جوالاً جزائرياً صالحاً (الأرضي 02x/03x/04x غير مقبول بالشحن)
export function normalizeAlgerianMobile(raw) {
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    let digits = String(raw)
        .replace(/[٠-٩]/g, ch => String(ch.charCodeAt(0) - 0x0660))
        .replace(/[۰-۹]/g, ch => String(ch.charCodeAt(0) - 0x06F0))
        .replace(/[\s\-.()]/g, "");

    if (digits.startsWith("+213")) digits = "0" + digits.slice(4);
    else if (digits.startsWith("00213")) digits = "0" + digits.slice(5);
    else if (/^213[567]\d{8}$/.test(digits)) digits = "0" + digits.slice(3);
    else if (/^[567]\d{8}$/.test(digits)) digits = "0" + digits;

    return /^0[567]\d{8}$/.test(digits) ? digits : null;
}

function assertCourierAndCredentials(courier, credentials) {
    if (typeof courier !== "string" || !/^[a-z0-9_-]{2,40}$/.test(courier)) {
        throw new ShippingError("MISSING_CREDENTIALS", "شركة التوصيل المختارة غير صالحة — راجع إعدادات الشحن");
    }
    if (courier === "sandbox") return; // وضع التجربة لا يحتاج بيانات اعتماد
    const entries = credentials && typeof credentials === "object" && !Array.isArray(credentials) ? Object.entries(credentials) : [];
    const valid = entries.length >= 1 && entries.length <= 8 &&
        entries.every(([key, value]) => typeof key === "string" && typeof value === "string" && value.trim() !== "");
    if (!valid) throw new ShippingError("MISSING_CREDENTIALS");
}

// قائمة بيضاء للخيارات المسموح تمريرها (لا نمرّر أي شيء غير معروف من التاجر كما هو)
function buildOptions(options, dzshipTimeoutMs = DZSHIP_TIMEOUT_MS) {
    const out = { timeoutMs: dzshipTimeoutMs };
    if (options && Number.isInteger(options.fromWilaya) && options.fromWilaya >= 1 && options.fromWilaya <= 58) {
        out.fromWilaya = options.fromWilaya;
    }
    // baseUrl خاص بشركة ecotrack العامة فقط، وdzship نفسها تتحقق منه وترفض أي نطاق غير مسموح
    if (options && typeof options.baseUrl === "string" && options.baseUrl.length <= 200) {
        out.baseUrl = options.baseUrl;
    }
    return out;
}

// روابط البوليصة الراجعة من طرف خارجي تُعرض كرابط قابل للنقر بواجهة التاجر — نقبل http/https فقط
// (يمنع أي رابط من نوع javascript: أو data: قد يُنفَّذ عند النقر)
function safeHttpUrl(value) {
    if (typeof value !== "string" || value.length > 2000) return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
    } catch {
        return null;
    }
}

// ============================================
// مطابقة البلدية: موقعنا يخزّنها بالعربي، وشركات التوصيل تشترط الاسم الفرنسي بالحرف
// (التوثيق: "Wrong commune = the #1 create error") — نأخذ الاسم الفرنسي من قائمة dzship نفسها
// ============================================

function normalizeArabic(text) {
    return String(text).normalize("NFKC")
        .replace(/[\u064B-\u065F\u0670\u0640]/g, "")   // التشكيل والتطويل
        .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
        .replace(/[\s\-_'’.]/g, "");
}

function normalizeLatin(text) {
    return String(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function getCommunesOfWilaya(wilayaNumber) {
    const cached = communesIsolateCache.get(wilayaNumber);
    if (cached && Date.now() - cached.at < COMMUNES_ISOLATE_TTL_MS) return cached.list;

    // الشكل الموثّق لدى dzship لقائمة ولاية واحدة هو `/v1/communes?31` (رقم الولاية مباشرة بلا اسم وسيط)
    const data = await dzshipRequest(`/v1/communes?${wilayaNumber}`, { cacheable: true });
    if (!Array.isArray(data)) throw new ShippingError("INVALID_RESPONSE", null, { retryable: true });

    // تصفية دفاعية: لو حملت كل بلدية رمز ولايتها (باسم من الأسماء المحتملة)، نُبقي بلديات هذه الولاية فقط —
    // فلا تُطابَق بلدية الزبون أبداً مع بلدية بولاية أخرى حتى لو أعادت البوابة قائمة أوسع من المطلوب
    const belongsToWilaya = (c) => {
        const code = c.wilayaCode ?? c.wilaya_code ?? c.wilaya;
        const n = Number(code);
        return code === undefined || code === null || !Number.isFinite(n) || n === wilayaNumber;
    };
    const list = data.filter(c => c && typeof c.nameFr === "string" && c.nameFr.trim() !== "" && belongsToWilaya(c));
    if (list.length === 0 || list.length > MAX_COMMUNES_PER_WILAYA) {
        throw new ShippingError("INVALID_RESPONSE", null, { retryable: true });
    }

    communesIsolateCache.set(wilayaNumber, { at: Date.now(), list });
    return list;
}

// يرجع الاسم الفرنسي الذي تقبله شركات التوصيل للبلدية المخزّنة عندنا (بالعربي عادةً)
// عند الفشل: COMMUNE_NOT_FOUND / COMMUNE_AMBIGUOUS (غير قابلة للإعادة — تحتاج تدخّل التاجر)
export async function resolveCommuneFr(wilayaCode, communeName) {
    const wilayaNumber = parseInt(wilayaCode, 10);
    if (!Number.isInteger(wilayaNumber) || wilayaNumber < 1 || wilayaNumber > 58 || typeof communeName !== "string" || !communeName.trim()) {
        throw new ShippingError("COMMUNE_NOT_FOUND");
    }
    const list = await getCommunesOfWilaya(wilayaNumber);

    const target = normalizeArabic(communeName);
    const targetNoArticle = target.replace(/^ال/, "");
    const targetLatin = normalizeLatin(communeName);

    // ترتيب المطابقة من الأدق للأوسع: عربي مطابق تماماً ← عربي بدون "ال" ← فرنسي (لو الزبون/التاجر كتبها لاتينياً)
    const attempts = [
        c => typeof c.nameAr === "string" && normalizeArabic(c.nameAr) === target,
        c => typeof c.nameAr === "string" && normalizeArabic(c.nameAr).replace(/^ال/, "") === targetNoArticle,
        c => targetLatin !== "" && (normalizeLatin(c.nameFr) === targetLatin ||
            (typeof c.gazetteName === "string" && normalizeLatin(c.gazetteName) === targetLatin))
    ];

    for (const matches of attempts) {
        const found = list.filter(matches);
        if (found.length === 0) continue;
        const distinct = [...new Set(found.map(c => c.nameFr))];
        if (distinct.length === 1) return distinct[0];
        throw new ShippingError("COMMUNE_AMBIGUOUS", `${ERROR_MESSAGES_AR.COMMUNE_AMBIGUOUS} («${cleanUpstreamText(communeName, 60)}») — أنشئ هذه الشحنة يدوياً`);
    }
    throw new ShippingError("COMMUNE_NOT_FOUND", `${ERROR_MESSAGES_AR.COMMUNE_NOT_FOUND} («${cleanUpstreamText(communeName, 60)}») — أنشئ هذه الشحنة يدوياً`);
}

// ============================================
// مكاتب الاستلام (POST /v1/desks): القائمة التي تعرضها الشركة لولاية واحدة. عملية قراءة فقط، آمنة للإعادة دائماً.
// التوثيق يوصي بتخزينها يوماً لكل (شركة، ولاية) — هذا ما يفعله src/shipping-desks.js (هنا لا كاش ولا قاعدة)
// ============================================
const MAX_DESKS_PER_WILAYA = 300;

export async function listStopDesks({ courier, credentials, wilayaCode, requestTimeoutMs = 9000 }) {
    assertCourierAndCredentials(courier, credentials);
    const wilayaNumber = parseInt(wilayaCode, 10);
    if (!Number.isInteger(wilayaNumber) || wilayaNumber < 1 || wilayaNumber > 58) {
        throw new ShippingError("LOCAL_VALIDATION", "الولاية غير صالحة");
    }
    const body = { courier, wilayaCode: wilayaNumber };
    if (courier !== "sandbox") body.credentials = credentials;

    const timeoutMs = Number.isInteger(requestTimeoutMs) ? Math.min(Math.max(requestTimeoutMs, 2000), CLIENT_TIMEOUT_MS) : 9000;
    const data = await dzshipRequest("/v1/desks", { method: "POST", body, secrets: Object.values(credentials || {}), timeoutMs });
    if (!Array.isArray(data)) throw new ShippingError("INVALID_RESPONSE", null, { retryable: true });

    // لا نثق بشكل أي عنصر: معرّف نصي/رقمي معقول فقط، بلا تكرار، بنصوص مقصوصة منظّفة (تُعرض بقائمة منسدلة بواجهة التاجر)
    const seen = new Set();
    const desks = [];
    for (const d of data) {
        if (!d || (typeof d.id !== "string" && typeof d.id !== "number")) continue;
        const id = String(d.id).trim();
        if (!id || id.length > 64 || seen.has(id)) continue;
        seen.add(id);
        desks.push({
            id,
            name: cleanUpstreamText(typeof d.name === "string" && d.name.trim() ? d.name : id, 120),
            communeName: typeof d.communeName === "string" && d.communeName.trim() ? cleanUpstreamText(d.communeName, 80) : null,
            address: typeof d.address === "string" && d.address.trim() ? cleanUpstreamText(d.address, 200) : null
        });
        if (desks.length >= MAX_DESKS_PER_WILAYA) break;
    }
    return desks;
}

// ترتيب المكاتب لخدمة التاجر: مكاتب بلدية الزبون أولاً ثم الباقي أبجدياً، مع علامة inCommune.
// suggestedId لا يُحدَّد إلا لو يوجد مكتب واحد بالضبط ببلدية الزبون (غير ذلك = على التاجر الاختيار، فلا نخمّن)
export function rankDesksForCommune(desks, communeFr) {
    const target = typeof communeFr === "string" ? normalizeLatin(communeFr) : "";
    const flagged = desks.map(d => ({ ...d, inCommune: target !== "" && !!d.communeName && normalizeLatin(d.communeName) === target }));
    flagged.sort((a, b) => (Number(b.inCommune) - Number(a.inCommune)) || a.name.localeCompare(b.name, "fr"));
    const inCommune = flagged.filter(d => d.inCommune);
    return { desks: flagged, suggestedId: inCommune.length === 1 ? inCommune[0].id : null, inCommuneCount: inCommune.length };
}

// ============================================
// بناء طلب الشحنة من صف الطلب (orders) وبنوده (order_items) — دالة بحتة قابلة للاختبار بمعزل عن الشبكة
// ============================================

// أنواع التوصيل عندنا: home / office. عند dzship: home / stopdesk
// ملاحظة: شركات كثيرة (Yalidine وغيرها) تحتاج stopDeskId محدداً لتوصيل المكتب، وميزة اختيار المكتب مؤجلة —
// لذلك يمكن تمريره اختيارياً هنا كي لا نحتاج إعادة كتابة الملف عند إضافتها لاحقاً
export function buildDzshipOrder({ order, items, wilayaCode, communeNameFr, stopDeskId = null }) {
    const problems = {};

    const phone = normalizeAlgerianMobile(order.customer_phone);
    if (!phone) problems.phone = "رقم الهاتف ليس جوالاً جزائرياً صالحاً";

    const wilayaNumber = parseInt(wilayaCode, 10);
    if (!Number.isInteger(wilayaNumber) || wilayaNumber < 1 || wilayaNumber > 58) problems.wilayaCode = "الولاية غير صالحة";

    const fullName = `${order.customer_name || ""} ${order.customer_lastname || ""}`.replace(/\s+/g, " ").trim().slice(0, 120);
    if (fullName.length < 2) problems.fullName = "اسم الزبون قصير جداً";

    if (typeof communeNameFr !== "string" || !communeNameFr.trim()) problems.communeName = "البلدية غير محددة";

    // المبلغ المطلوب تحصيله من الزبون عند الاستلام (دج، عدد صحيح). موقعنا دفع عند الاستلام فقط.
    const codAmount = Math.round(Number(order.total));
    if (!Number.isFinite(codAmount) || codAmount < 0) problems.codAmount = "مبلغ الطلب غير صالح";

    if (Object.keys(problems).length > 0) {
        throw new ShippingError("LOCAL_VALIDATION", `${ERROR_MESSAGES_AR.LOCAL_VALIDATION}: ${Object.values(problems).join("، ")}`, { fields: problems });
    }

    const deliveryType = order.delivery_type === "office" ? "stopdesk" : "home";
    const productList = (Array.isArray(items) ? items : [])
        .map(i => `${i.product_name}${i.selected_attributes ? ` (${i.selected_attributes})` : ""} x${i.quantity}`)
        .join("، ")
        .slice(0, 500) || "طلب";

    const dzshipOrder = {
        reference: String(order.order_number).slice(0, 64),
        recipient: {
            fullName,
            phone,
            wilayaCode: wilayaNumber,
            communeName: communeNameFr.trim(),
            addressLine: String(order.full_address || "").slice(0, 255)
        },
        deliveryType,
        productList,
        codAmount
    };
    if (deliveryType === "stopdesk" && stopDeskId) dzshipOrder.stopDeskId = String(stopDeskId);
    return dzshipOrder;
}

// ============================================
// العمليات الأساسية
// ============================================

// إنشاء شحنة فعلية بشركة التوصيل — العملية الوحيدة ذات الأثر الجانبي، لذلك حالة الغموض تُعامَل بحذر
export async function createShipment({ courier, credentials, options = {}, order }) {
    assertCourierAndCredentials(courier, credentials);
    const body = { courier, options: buildOptions(options), order };
    if (courier !== "sandbox") body.credentials = credentials;

    const data = await dzshipRequest("/v1/orders", { method: "POST", body, mayHaveSideEffects: true, secrets: Object.values(credentials || {}) });

    // نجاح بدون رقم تتبع صالح = شذوذ خطير: قد تكون الشحنة أُنشئت. نعامله غموضاً لا فشلاً عادياً
    if (typeof data.trackingNumber !== "string" || data.trackingNumber.trim() === "") {
        throw new ShippingError("INVALID_RESPONSE", null, { ambiguous: true, retryable: false });
    }
    return {
        trackingNumber: data.trackingNumber.trim().slice(0, 80),
        labelUrl: safeHttpUrl(data.labelUrl),
        status: typeof data.status === "string" ? data.status.slice(0, 40) : "created",
        courierReference: typeof data.courierReference === "string" ? data.courierReference.slice(0, 80) : null
    };
}

// الدالة التي سيستدعيها الطابور: تجمع مطابقة البلدية + بناء الطلب + الإنشاء بخطوة واحدة
export async function createShipmentForOrder({ courier, credentials, options = {}, order, items, wilayaCode, stopDeskId = null, stopDeskCommune = null }) {
    assertCourierAndCredentials(courier, credentials); // فحص مبكر قبل أي استدعاء خارجي للبلديات
    // توثيق dzship: عند التوصيل لمكتب محدد "ترسل بلدية المكتب نفسها (communeName) كبلدية للمستلم لو كانت للمكتب بلدية" —
    // بلدية المكتب بتهجئة الشركة نفسها، فلا حاجة لمطابقتها مع قائمتنا. وبدون مكتب محدد نطابق بلدية الزبون كالمعتاد
    const useDeskCommune = order.delivery_type === "office" && stopDeskId && typeof stopDeskCommune === "string" && stopDeskCommune.trim() !== "";
    const communeNameFr = useDeskCommune ? stopDeskCommune.trim() : await resolveCommuneFr(wilayaCode, order.commune);
    const dzshipOrder = buildDzshipOrder({ order, items, wilayaCode, communeNameFr, stopDeskId });
    return createShipment({ courier, credentials, options, order: dzshipOrder });
}

// حالة الشحنة الحالية + سجل الأحداث — عملية قراءة فقط، آمنة للإعادة دائماً
export async function trackShipment({ courier, credentials, options = {}, trackingNumber }) {
    assertCourierAndCredentials(courier, credentials);
    if (typeof trackingNumber !== "string" || trackingNumber.trim() === "" || trackingNumber.length > 80) {
        throw new ShippingError("LOCAL_VALIDATION", "رقم التتبع غير صالح");
    }
    const body = { courier, options: buildOptions(options), trackingNumber: trackingNumber.trim() };
    if (courier !== "sandbox") body.credentials = credentials;

    const data = await dzshipRequest("/v1/track", { method: "POST", body, secrets: Object.values(credentials || {}) });

    // أي حالة خارج المفردات الـ14 المعروفة تُحوَّل إلى unknown (لا نخزّن نصاً غريباً بقاعدة بياناتنا أبداً)
    const known = (s) => (typeof s === "string" && Object.prototype.hasOwnProperty.call(SHIPPING_STATUS_LABELS_AR, s)) ? s : "unknown";
    const events = (Array.isArray(data.events) ? data.events : []).slice(-50).map(e => ({
        status: known(e && e.status),
        rawStatus: cleanUpstreamText(e && e.rawStatus, 200),
        timestamp: e && typeof e.timestamp === "string" && !Number.isNaN(Date.parse(e.timestamp)) ? e.timestamp : null
    }));
    const status = known(data.status);

    return {
        trackingNumber: trackingNumber.trim(),
        status,
        isTerminal: TERMINAL_SHIPPING_STATUSES.includes(status),
        events
    };
}

// سعر التوصيل الحقيقي من شركة التوصيل لمسار (ولاية وصول + نوع توصيل) — عملية قراءة، آمنة للإعادة
// عمداً لا نمرّر البلدية: السعر على مستوى الولاية يجعل المفتاح قابلاً للكاش بعدد صغير جداً من التوليفات
// requestTimeoutMs: مسار السعر يقف خلفه زبون ينتظر بصفحة المنتج/الدفع — لا يجوز أن يعلّق 25 ثانية عند تعثّر
// البوابة. مهلة قصيرة تعني الرجوع فوراً للسعر اليدوي الاحتياطي (مهلة dzship الداخلية أقصر منها بثانية)
export async function getShippingRate({ courier, credentials, options = {}, toWilaya, deliveryType, tier = "express", codAmount = null, requestTimeoutMs = 6000 }) {
    assertCourierAndCredentials(courier, credentials);
    const wilayaNumber = parseInt(toWilaya, 10);
    if (!Number.isInteger(wilayaNumber) || wilayaNumber < 1 || wilayaNumber > 58 || !["home", "stopdesk"].includes(deliveryType) || !["express", "economic"].includes(tier)) {
        throw new ShippingError("LOCAL_VALIDATION", "بيانات استعلام السعر غير صالحة");
    }
    const clientTimeout = Number.isInteger(requestTimeoutMs) ? Math.min(Math.max(requestTimeoutMs, 2000), CLIENT_TIMEOUT_MS) : 6000;
    const built = buildOptions(options, Math.max(1000, clientTimeout - 1000));
    const query = { toWilaya: wilayaNumber, deliveryType, tier };
    if (built.fromWilaya) query.fromWilaya = built.fromWilaya;
    if (Number.isInteger(codAmount) && codAmount >= 0) query.codAmount = codAmount;

    const body = { courier, options: built, query };
    if (courier !== "sandbox") body.credentials = credentials;

    const data = await dzshipRequest("/v1/rates", { method: "POST", body, secrets: Object.values(credentials || {}), timeoutMs: clientTimeout });

    const validFee = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
    if (!validFee(data.deliveryFee)) {
        // لا نعرض ولا نخزّن سعراً غير منطقي أبداً — المتصل يرجع للسعر اليدوي الاحتياطي
        throw new ShippingError("INVALID_RESPONSE", null, { retryable: true });
    }
    return {
        deliveryFee: data.deliveryFee,
        returnFee: validFee(data.returnFee) ? data.returnFee : null,
        codFee: validFee(data.codFee) ? data.codFee : null,
        total: validFee(data.total) ? data.total : data.deliveryFee,
        estimatedDays: validFee(data.estimatedDays) ? data.estimatedDays : null,
        deliveryType
    };
}

// قائمة شركات التوصيل المدعومة (بيانات مرجعية بلا بيانات اعتماد) — كاش حافة يوم كامل
// q: بحث بالاسم، platform: مثلاً ecotrack — كلاهما اختياري
export async function listCouriers({ q = "", platform = "" } = {}) {
    const params = new URLSearchParams();
    if (typeof q === "string" && q.trim()) params.set("q", q.trim().slice(0, 50));
    if (typeof platform === "string" && platform.trim()) params.set("platform", platform.trim().slice(0, 30));
    const qs = params.toString();

    const data = await dzshipRequest(`/v1/couriers${qs ? `?${qs}` : ""}`, { cacheable: true });
    if (!Array.isArray(data)) throw new ShippingError("INVALID_RESPONSE", null, { retryable: true });

    return data
        .filter(c => c && typeof c.key === "string" && /^[a-z0-9_-]{2,40}$/.test(c.key) && typeof c.name === "string")
        .map(c => ({
            key: c.key,
            name: cleanUpstreamText(c.name, 80),
            platform: typeof c.platform === "string" ? c.platform.slice(0, 30) : null,
            requiredCredentials: Array.isArray(c.requiredCredentials) ? c.requiredCredentials.filter(f => typeof f === "string" && /^[A-Za-z0-9_]{1,30}$/.test(f)).slice(0, 8) : [],
            requiresBaseUrl: c.requiresBaseUrl === true,
            featured: FEATURED_COURIER_KEYS.includes(c.key)
        }));
}
