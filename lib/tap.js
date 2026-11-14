const API_BASE = "https://api.tap.company/v2";

function enabled() {
  return !!process.env.TAP_SECRET_KEY;
}

// Tap's hosted Checkout page — customer is redirected there to pay with mada,
// Apple Pay, STC Pay, or cards. Tap runs 3-D Secure on the card itself before
// authorizing, and we never see card details (src_all = let Tap decide which
// methods to show based on what's enabled on the merchant dashboard).
async function createCharge({ amountSar, description, name, phone, bookingRef, redirectUrl, webhookUrl }) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] || "عميلة";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : firstName;
  const res = await fetch(API_BASE + "/charges", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.TAP_SECRET_KEY },
    body: JSON.stringify({
      amount: Number(amountSar.toFixed(2)),
      currency: "SAR",
      threeDSecure: true,
      save_card: false,
      customer_initiated: true,
      description,
      metadata: { bookingRef },
      reference: { order: bookingRef },
      receipt: { email: false, sms: false },
      customer: {
        first_name: firstName,
        last_name: lastName,
        phone: { country_code: "966", number: String(phone).replace(/^0/, "") }
      },
      source: { id: "src_all" },
      redirect: { url: redirectUrl },
      post: { url: webhookUrl }
    })
  });
  const data = await res.json();
  if (!res.ok || !data.id) {
    throw new Error((data && data.errors && data.errors[0] && data.errors[0].description) || "تعذر إنشاء عملية الدفع عبر Tap");
  }
  const url = data.transaction && data.transaction.url;
  if (!url) throw new Error("Tap ما رجعت رابط دفع صالح");
  return { chargeId: data.id, url, status: data.status };
}

// The webhook body is never trusted on its own — a charge id in a POST body
// is trivial to forge. Instead we use it only as a "go check this" signal and
// re-fetch the charge straight from Tap over our own secret-key-authenticated
// connection; that response is the only thing we ever act on.
async function retrieveCharge(chargeId) {
  const res = await fetch(API_BASE + "/charges/" + encodeURIComponent(chargeId), {
    headers: { Authorization: "Bearer " + process.env.TAP_SECRET_KEY }
  });
  const data = await res.json();
  if (!res.ok || !data.id) throw new Error("تعذر التحقق من حالة الدفع مع Tap");
  return data; // { id, status: INITIATED|IN_PROGRESS|CAPTURED|DECLINED|..., reference, amount, currency, ... }
}

module.exports = { enabled, createCharge, retrieveCharge };
