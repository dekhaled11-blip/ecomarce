// ============================================
// وحدة رفع الصور إلى Cloudflare R2
// تُستخدم لصور المنتجات وإثباتات دفع التجار
// ============================================

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 ميغابايت كحد أقصى لكل صورة
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

// فحص التوقيع الحقيقي لبايتات الملف (Magic Bytes) — لا نثق أبداً بنوع الملف الذي يرسله المتصفح فقط
// (يمكن لأي شخص تسمية ملف ضار بامتداد .jpg، فحص البايتات الفعلية يمنع هذا)
function detectRealImageType(bytes) {
    if (bytes.length < 12) return null;
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
    const isRIFF = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const isWEBP = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    if (isRIFF && isWEBP) return "image/webp";
    return null;
}

function extensionFor(mimeType) {
    return { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[mimeType];
}

// ---------------------------------------------
// POST /api/vendors/upload-image — رفع صورة واحدة (محمي: تسجيل دخول التاجر)
// يُستخدم لصور المنتجات وإثباتات الدفع على حدٍ سواء (نفس آلية التخزين)
// ---------------------------------------------
export async function handleUploadImage(request, env, auth) {
    let formData;
    try {
        formData = await request.formData();
    } catch {
        return jsonResponse({ error: "يجب إرسال الملف بصيغة multipart/form-data" }, 400);
    }

    const file = formData.get("file");
    if (!file || typeof file === "string") {
        return jsonResponse({ error: "لم يتم إرفاق أي ملف" }, 400);
    }

    if (file.size > MAX_FILE_SIZE) {
        return jsonResponse({ error: "حجم الصورة يتجاوز الحد المسموح (5 ميغابايت)" }, 400);
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
        return jsonResponse({ error: "صيغة الملف غير مدعومة. المسموح: JPEG, PNG, WEBP فقط" }, 400);
    }

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // التحقق الحقيقي من نوع الملف عبر بايتاته، وليس فقط الامتداد أو Content-Type المُرسَل
    const realType = detectRealImageType(bytes);
    if (!realType) {
        return jsonResponse({ error: "الملف ليس صورة صالحة فعلياً (فشل التحقق من نوعه الحقيقي)" }, 400);
    }

    const ext = extensionFor(realType);
    // مسار فريد لكل ملف، مبني على معرف التاجر (عزل التجار عن بعضهم) + معرف عشوائي فريد
    const key = `vendors/${auth.vendor_id}/${crypto.randomUUID()}.${ext}`;

    await env.IMAGES.put(key, bytes, {
        httpMetadata: { contentType: realType }
    });

    const url = `${env.R2_PUBLIC_URL}/${key}`;
    return jsonResponse({ message: "تم رفع الصورة بنجاح", url, key }, 201);
}
