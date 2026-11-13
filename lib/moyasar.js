const crypto = require("crypto");

const API_BASE = "https://api.moyasar.com/v1";

function enabled() {
  return !!process.env.MOYASAR_SECRET_KEY;
}

// Moyasar's hosted Invoice page — customer is redirected there to pay with
// whatever methods are enabled on the merchant dashboard (mada, cards, Apple
// Pay, and Tabby/Tamara if Hebah turns those on). We never see card details.
async function createInvoice({ amountSar, description, metadata, successUrl, backUrl }) {
  const auth = Buffer.from(process.env.MOYASAR_SECRET_KEY + ":").toString("base64");
  const res = await fetch(API_BASE + "/invoices", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + auth },
    body: JSON.stringify({
      amount: Math.round(amountSar * 100), // Moyasar amounts are in halalas
      currency: "SAR",
      description,
      success_url: successUrl,
      back_url: backUrl,
      metadata
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.message) || "تعذر إنشاء فاتورة الدفع");
  }
  return data; // { id, status, url, ... }
}

// Moyasar signs webhooks by echoing back the secret_token you set when
// registering the webhook in their dashboard, inside the JSON body itself —
// there's no HMAC header, so this is a plain (constant-time) string compare.
function verifyWebhookSecret(bodySecretToken) {
  const expected = process.env.MOYASAR_WEBHOOK_SECRET;
  if (!expected || !bodySecretToken) return false;
  const a = Buffer.from(String(bodySecretToken));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { enabled, createInvoice, verifyWebhookSecret };
