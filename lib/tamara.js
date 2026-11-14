const crypto = require("crypto");

// Tamara also needs its own separate merchant application — an API token
// plus a Notification Token (for verifying webhook JWTs), both distinct
// from Tap's and Tabby's credentials.
const API_BASE = "https://api.tamara.co";

function enabled() {
  return !!(process.env.TAMARA_API_TOKEN && process.env.TAMARA_NOTIFICATION_TOKEN);
}

async function createCheckoutSession({ amountSar, description, name, phone, branchName, bookingRef, successUrl, cancelUrl, failureUrl }) {
  const [firstName, ...rest] = name.trim().split(/\s+/);
  const lastName = rest.join(" ") || firstName;
  const res = await fetch(API_BASE + "/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.TAMARA_API_TOKEN },
    body: JSON.stringify({
      order_reference_id: bookingRef,
      total_amount: { amount: amountSar, currency: "SAR" },
      shipping_amount: { amount: 0, currency: "SAR" },
      tax_amount: { amount: 0, currency: "SAR" },
      description,
      country_code: "SA",
      payment_type: "PAY_NOW",
      items: [{
        reference_id: bookingRef, type: "Digital", name: description, sku: bookingRef,
        quantity: 1, unit_price: { amount: amountSar, currency: "SAR" }, total_amount: { amount: amountSar, currency: "SAR" }
      }],
      consumer: { first_name: firstName, last_name: lastName, phone_number: phone, email: `${phone}@customer.hebah.sa` },
      // There's no physical shipment for a salon appointment — Tamara still
      // requires this block, so it's filled with the branch as a stand-in.
      shipping_address: { first_name: firstName, last_name: lastName, line1: branchName, city: branchName, country_code: "SA" },
      merchant_url: { success: successUrl, failure: failureUrl, cancel: cancelUrl }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data && data.message) || "تعذر إنشاء جلسة الدفع مع تمارا");
  return { orderId: data.order_id, checkoutId: data.checkout_id, url: data.checkout_url };
}

// Tamara's own docs: once an order is authorised, treat it as paid.
async function authoriseOrder(orderId) {
  const res = await fetch(API_BASE + `/orders/${orderId}/authorise`, {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.TAMARA_API_TOKEN }
  });
  if (!res.ok) throw new Error("فشل تأكيد الطلب مع تمارا");
  return res.json();
}

// Tamara signs webhooks as an HS256 JWT (in the tamaraToken query param and
// as a Bearer Authorization header) using your Notification Token as the
// shared secret — verified here by hand since it's one HMAC comparison and
// not worth a dependency for.
function verifyWebhookJwt(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const expectedSig = crypto.createHmac("sha256", process.env.TAMARA_NOTIFICATION_TOKEN)
    .update(headerB64 + "." + payloadB64)
    .digest("base64url");
  const a = Buffer.from(sigB64), b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")); }
  catch (e) { return null; }
}

module.exports = { enabled, createCheckoutSession, authoriseOrder, verifyWebhookJwt };
