// ============================================
// المهام المجدولة (Cron Trigger) — تُشغَّل تلقائياً يومياً
// حالياً: تحذيرات اقتراب انتهاء التجربة/الاشتراك فقط
// (أتمتة تحويل الحالة الفعلية trial → pending_payment لم تُبنَ بعد — مهمة منفصلة لاحقة)
// ============================================
import { createNotification } from "./notifications.js";

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
// المُشغِّل الرئيسي المستدعى من Cloudflare عند كل تفعيل للـ Cron Trigger
// ---------------------------------------------
export async function runScheduledChecks(env) {
    // ملاحظة: التحذير والانتهاء الفعلي لا يتداخلان أبداً لنفس التاجر بنفس الدورة —
    // شرط "trial_ends_at > now" داخل checkTrialWarnings يستبعد أي تجربة منتهية فعلاً من التحذير
    const [trialResult, subscriptionResult, expiryResult] = await Promise.all([
        checkTrialWarnings(env),
        checkSubscriptionWarnings(env),
        checkTrialExpiry(env)
    ]);
    return { trial_warnings: trialResult, subscription_warnings: subscriptionResult, trial_expiry: expiryResult };
}
