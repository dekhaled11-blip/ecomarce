// ============================================
// بيانات مرجعية: قائمة ولايات الجزائر الـ58 الرسمية
// ملاحظة مهمة: هذه القائمة تشمل الولايات فقط (بيانات ثابتة ومستقرة).
// قائمة البلديات (أكثر من 1500 بلدية) لم تُضَف بعد بانتظار مصدر رسمي يزوّدنا به بب.
// ============================================

export const WILAYAS = [
    { code: "01", name: "أدرار" }, { code: "02", name: "الشلف" }, { code: "03", name: "الأغواط" },
    { code: "04", name: "أم البواقي" }, { code: "05", name: "باتنة" }, { code: "06", name: "بجاية" },
    { code: "07", name: "بسكرة" }, { code: "08", name: "بشار" }, { code: "09", name: "البليدة" },
    { code: "10", name: "البويرة" }, { code: "11", name: "تمنراست" }, { code: "12", name: "تبسة" },
    { code: "13", name: "تلمسان" }, { code: "14", name: "تيارت" }, { code: "15", name: "تيزي وزو" },
    { code: "16", name: "الجزائر" }, { code: "17", name: "الجلفة" }, { code: "18", name: "جيجل" },
    { code: "19", name: "سطيف" }, { code: "20", name: "سعيدة" }, { code: "21", name: "سكيكدة" },
    { code: "22", name: "سيدي بلعباس" }, { code: "23", name: "عنابة" }, { code: "24", name: "قالمة" },
    { code: "25", name: "قسنطينة" }, { code: "26", name: "المدية" }, { code: "27", name: "مستغانم" },
    { code: "28", name: "المسيلة" }, { code: "29", name: "معسكر" }, { code: "30", name: "ورقلة" },
    { code: "31", name: "وهران" }, { code: "32", name: "البيض" }, { code: "33", name: "إليزي" },
    { code: "34", name: "برج بوعريريج" }, { code: "35", name: "بومرداس" }, { code: "36", name: "الطارف" },
    { code: "37", name: "تندوف" }, { code: "38", name: "تيسمسيلت" }, { code: "39", name: "الوادي" },
    { code: "40", name: "خنشلة" }, { code: "41", name: "سوق أهراس" }, { code: "42", name: "تيبازة" },
    { code: "43", name: "ميلة" }, { code: "44", name: "عين الدفلى" }, { code: "45", name: "النعامة" },
    { code: "46", name: "عين تموشنت" }, { code: "47", name: "غرداية" }, { code: "48", name: "غليزان" },
    { code: "49", name: "تيميمون" }, { code: "50", name: "برج باجي مختار" }, { code: "51", name: "أولاد جلال" },
    { code: "52", name: "بني عباس" }, { code: "53", name: "عين صالح" }, { code: "54", name: "عين قزام" },
    { code: "55", name: "تقرت" }, { code: "56", name: "جانت" }, { code: "57", name: "المغير" },
    { code: "58", name: "المنيعة" }
];

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=86400" // بيانات ثابتة تقريباً، تخزين مؤقت ليوم كامل
        }
    });
}

// ---------------------------------------------
// GET /api/public/communes?wilaya=XX — بلديات ولاية معينة (عامة، بدون تسجيل دخول)
// استعلام واحد مفهرس فقط (idx_communes_wilaya) — خفيف جداً، ونفس رأس التخزين المؤقت
// المستخدم بالولايات (بيانات شبه ثابتة، تتغيّر نادراً جداً)
// ---------------------------------------------
export async function handleListCommunes(request, env) {
    const url = new URL(request.url);
    const wilayaCode = url.searchParams.get("wilaya");

    if (!wilayaCode) {
        return jsonResponse({ error: "يرجى تحديد رمز الولاية" }, 400);
    }

    const { results } = await env.DB.prepare(
        "SELECT id, name FROM communes WHERE wilaya_code = ? ORDER BY name"
    ).bind(wilayaCode).all();

    return jsonResponse({ communes: results });
}

// ---------------------------------------------
// GET /api/public/wilayas — قائمة الولايات (عامة، بدون تسجيل دخول)
// ---------------------------------------------
export async function handleListWilayas(request, env) {
    return jsonResponse({ wilayas: WILAYAS });
}
