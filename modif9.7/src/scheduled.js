// ============================================
// المهام المجدولة (Cron Trigger)
// جدول واحد فقط `*/2 * * * *` (راجع wrangler.toml) يوزّع الأعمال الثلاثة بحسب وقت الجدولة نفسه (UTC):
//   • طابور إنشاء الشحنات: كل دورة (كل دقيقتين).
//   • تتبع الشحنات: أول دورة بكل ربع ساعة (الدقائق 0 و16 و30 و46 ← 96 مرة يومياً).
//   • فحص التجارب/الاشتراكات: الدورات 08:00 و08:02 و08:04 — ثلاث مرات متتالية عمداً (متكرر الأمان: أعلام وحالات تمنع أي تكرار)
//     فلا يضيع فحص اليوم لو تعذّرت دورة واحدة أو اثنتان.
// جدول واحد بدل ثلاثة يبقي حساب Cloudflare بعيداً عن حد عدد جداول الـCron، ويُنقص استدعاءات الـWorker اليومية (720 بدل 817).
// القيم القديمة لـevent.cron ("0 8 * * *" و"*/15 * * * *") ما زالت مدعومة لو بقي جدول قديم مفعّلاً بحساب ما.
// ============================================
import { createNotification } from "./notifications.js";
import { processShippingQueue, processShippingTracking } from "./shipping-queue.js";

const TRIAL_WARNING_HOURS_BEFORE = 24;        // تحذير قبل 24 ساعة من انتهاء التجربة
const SUBSCRIPTION_WARNING_HOURS_BEFORE = 48; // تحذير قبل 48 ساعة من انتهاء الاشتراك

// ---------------------------------------------
// فحص التجارب المجانية القاربة على الانتهاء
// ---------------------------------------------
async function checkTrialWarnings(env) {
    const threshold = new Date(Date.now() + TRIAL_WARNING_HOURS_BEFORE * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    // استعلام واحد يجلب فقط التجار المستهدفين فعلاً (لم يُرسَل لهم تحذير + تجربتهم لم تنتهِ بعد + قريبة من الانتهاء)
    const { results: vendors } = await env.DB.prepare(`
        SELECT id FROM vendors
        WHERE status = 'trial' AND trial_warning_sent = 0
          AND trial_ends_at <= ? AND trial_ends_at > ?
    `).bind(threshold, now).all();

    if (vendors.length === 0) return { checked: 0 };

    // دفعة واحدة (batch): إشعار كل تاجر + تعليم علامة "تم الإرسال" له، بدل استعلامات متتالية لكل تاجر
    const batchStatements = [];
    for (const vendor of vendors) {
        batchStatements.push(
            env.DB.prepare(
                "INSERT INTO notifications (vendor_id, type, message, link) VALUES (?, 'trial_ending_soon', ?, NULL)"
            ).bind(vendor.id, "تنتهي فترتك التجريبية المجانية خلال 24 ساعة. يرجى إتمام الدفع لتجنب تعليق متجرك.")
        );
        batchStatements.push(
            env.DB.prepare("UPDATE vendors SET trial_warning_sent = 1 WHERE id = ?").bind(vendor.id)
        );
    }
    await env.DB.batch(batchStatements);

    return { checked: vendors.length };
}

// ---------------------------------------------
// فحص الاشتراكات الشهرية القاربة على الانتهاء
// ---------------------------------------------
async function checkSubscriptionWarnings(env) {
    const threshold = new Date(Date.now() + SUBSCRIPTION_WARNING_HOURS_BEFORE * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    const { results: vendors } = await env.DB.prepare(`
        SELECT id FROM vendors
        WHERE status = 'active' AND subscription_warning_sent = 0
          AND subscription_ends_at <= ? AND subscription_ends_at > ?
    `).bind(threshold, now).all();

    if (vendors.length === 0) return { checked: 0 };

    const batchStatements = [];
    for (const vendor of vendors) {
        batchStatements.push(
            env.DB.prepare(
                "INSERT INTO notifications (vendor_id, type, message, link) VALUES (?, 'subscription_ending_soon', ?, NULL)"
            ).bind(vendor.id, "سينتهي اشتراكك الشهري خلال 48 ساعة. يرجى تجديد الاشتراك لتجنب تعليق متجرك.")
        );
        batchStatements.push(
            env.DB.prepare("UPDATE vendors SET subscription_warning_sent = 1 WHERE id = ?").bind(vendor.id)
        );
    }
    await env.DB.batch(batchStatements);

    return { checked: vendors.length };
}

// ---------------------------------------------
// تحويل التجارب المنتهية فعلياً إلى حالة "بانتظار الدفع" تلقائياً (بدون أي تدخل بشري)
// ---------------------------------------------
async function checkTrialExpiry(env) {
    const now = new Date().toISOString();

    const { results: vendors } = await env.DB.prepare(`
        SELECT id FROM vendors WHERE status = 'trial' AND trial_ends_at <= ?
    `).bind(now).all();

    if (vendors.length === 0) return { transitioned: 0 };

    const batchStatements = [];
    for (const vendor of vendors) {
        batchStatements.push(
            env.DB.prepare("UPDATE vendors SET status = 'pending_payment' WHERE id = ?").bind(vendor.id)
        );
        batchStatements.push(
            env.DB.prepare(
                "INSERT INTO notifications (vendor_id, type, message, link) VALUES (?, 'trial_expired', ?, NULL)"
            ).bind(vendor.id, "انتهت فترتك التجريبية المجانية. يرجى إتمام الدفع لإعادة تفعيل متجرك.")
        );
    }
    await env.DB.batch(batchStatements);

    return { transitioned: vendors.length };
}

// ---------------------------------------------
// تحديد أعمال هذه الدورة من وقت الجدولة (UTC) — دالة نقية قابلة للاختبار بلا قاعدة ولا شبكة
// ---------------------------------------------
export function planScheduledJobs(scheduledTimeMs) {
    const t = new Date(scheduledTimeMs);
    const minute = t.getUTCMinutes();
    return {
        queue: true,
        // أول دورة بكل ربع ساعة: ربع الساعة الحالي يختلف عن ربع الدورة السابقة (قبل دقيقتين). الدقائق: 0 و16 و30 و46
        tracking: Math.floor(minute / 15) !== Math.floor((minute - 2) / 15),
        daily: t.getUTCHours() === 8 && minute < 6
    };
}

// عزل الأعمال: فشل أي عمل (استثناء غير متوقع) لا يمنع بقية أعمال الدورة نفسها
async function isolated(label, job) {
    try {
        return await job();
    } catch (err) {
        console.error(`Scheduled job failed (${label}):`, err);
        return { error: String(err && err.message ? err.message : err) };
    }
}

async function runDailyChecks(env) {
    // ملاحظة: التحذير والانتهاء الفعلي لا يتداخلان أبداً لنفس التاجر بنفس الدورة —
    // شرط "trial_ends_at > now" داخل checkTrialWarnings يستبعد أي تجربة منتهية فعلاً من التحذير
    const [trialResult, subscriptionResult, expiryResult] = await Promise.all([
        checkTrialWarnings(env),
        checkSubscriptionWarnings(env),
        checkTrialExpiry(env)
    ]);
    return { trial_warnings: trialResult, subscription_warnings: subscriptionResult, trial_expiry: expiryResult };
}

// ---------------------------------------------
// المُشغِّل الرئيسي المستدعى من Cloudflare عند كل تفعيل لجدول الـ Cron Trigger
// cronExpression: القيمة الخام للجدول الذي أطلق هذا الاستدعاء (event.cron من src/index.js)
// scheduledTimeMs: وقت الجدولة (event.scheduledTime) — منه يُحدَّد عمل الدورة ورقم نافذة التتبع، فنتائجه حتمية وقابلة للاختبار
// ---------------------------------------------
export async function runScheduledChecks(env, cronExpression, scheduledTimeMs = Date.now()) {
    // الجدول الموحَّد الحالي
    if (cronExpression === "*/2 * * * *") {
        const plan = planScheduledJobs(scheduledTimeMs);
        const out = {};
        out.shipping_queue = await isolated("shipping_queue", () => processShippingQueue(env));
        if (plan.tracking) out.shipping_tracking = await isolated("shipping_tracking", () => processShippingTracking(env, scheduledTimeMs));
        if (plan.daily) out.daily = await isolated("daily", () => runDailyChecks(env));
        return out;
    }

    // جداول قديمة منفصلة (توافقاً مع أي جدول ما زال مفعّلاً، أو استدعاء بلا وسيط)
    if (!cronExpression || cronExpression === "0 8 * * *") return await runDailyChecks(env);
    if (cronExpression === "*/15 * * * *") return { shipping_tracking: await processShippingTracking(env, scheduledTimeMs) };

    return { skipped: true, reason: `جدول كرون غير معروف: ${cronExpression}` };
}
