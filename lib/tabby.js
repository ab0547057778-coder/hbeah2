// Tabby requires its own merchant application (separate from Tap) — a
// secret key AND a merchant_code from their integration team. KSA API base.
const API_BASE = "https://api.tabby.sa";

function enabled() {
  return !!(process.env.TABBY_SECRET_KEY && process.env.TABBY_MERCHANT_CODE);
}

async function createSession({ amountSar, description, name, phone, dob, bookingRef, successUrl, cancelUrl, failureUrl }) {
  const res = await fetch(API_BASE + "/api/v2/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.TABBY_SECRET_KEY },
    body: JSON.stringify({
      payment: {
        amount: amountSar.toFixed(2),
        currency: "SAR",
        description,
        buyer: { name, phone: "966" + phone.slice(1), email: `${phone}@customer.hebah.sa`, dob: dob || undefined },
        order: {
          reference_id: bookingRef,
          items: [{ title: description, quantity: 1, unit_price: amountSar.toFixed(2), category: "Beauty" }]
        }
      },
      lang: "ar",
      merchant_code: process.env.TABBY_MERCHANT_CODE,
      merchant_urls: { success: successUrl, cancel: cancelUrl, failure: failureUrl }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data && data.error) || "تعذر إنشاء جلسة الدفع مع تابي");
  const webUrl = data.configuration && data.configuration.available_products
    && data.configuration.available_products.installments
    && data.configuration.available_products.installments[0]
    && data.configuration.available_products.installments[0].web_url;
  if (!webUrl) throw new Error("تابي ما رجع رابط دفع صالح");
  return { sessionId: data.id, paymentId: data.payment.id, url: webUrl };
}

// Tabby only pays out once a payment is captured — authorization alone isn't
// money in the bank. Capturing the full amount also auto-closes the payment.
async function capture(paymentId, amountSar) {
  const res = await fetch(API_BASE + `/api/v2/payments/${paymentId}/captures`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.TABBY_SECRET_KEY },
    body: JSON.stringify({ amount: amountSar.toFixed(2) })
  });
  if (!res.ok) throw new Error("فشل تحصيل الدفعة من تابي");
  return res.json();
}

// Verification header is whatever title/value pair you registered the
// webhook with — not a signature, just a shared secret you chose yourself.
function verifyWebhookHeader(headerValue) {
  const expected = process.env.TABBY_WEBHOOK_SECRET;
  return !!expected && headerValue === expected;
}

module.exports = { enabled, createSession, capture, verifyWebhookHeader };
