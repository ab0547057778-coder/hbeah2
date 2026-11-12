const GATEWAYS = ["all", "tabby", "tamara", "card"];

function todayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Finds an active discount matching this code, service and payment gateway,
// valid on the current date. Returns { ok:true, discount, finalPrice } or
// { ok:false, error }. Server is the only source of truth for the computed
// price — the client never gets to assert a discount amount itself.
function evaluate(data, { code, serviceId, pay }) {
  const service = data.services.find(s => s.id === serviceId);
  if (!service) return { ok: false, error: "خدمة غير صحيحة" };

  const needle = String(code || "").trim().toUpperCase();
  if (!needle) return { ok: false, error: "اكتبي كود الخصم" };

  const discount = data.discounts.find(d => d.code === needle);
  if (!discount || !discount.active) return { ok: false, error: "كود الخصم غير صحيح" };

  const today = todayKey();
  if (discount.startDate && today < discount.startDate) return { ok: false, error: "كود الخصم لم يبدأ بعد" };
  if (discount.endDate && today > discount.endDate) return { ok: false, error: "انتهت صلاحية كود الخصم" };

  if (discount.gateway !== "all" && discount.gateway !== pay) {
    return { ok: false, error: "هذا الكود يسري فقط مع طريقة دفع محددة" };
  }
  if (!discount.serviceIds.includes("all") && !discount.serviceIds.includes(serviceId)) {
    return { ok: false, error: "هذا الكود لا يسري على هذه الخدمة" };
  }

  const finalPrice = Math.max(0, Math.round(service.price * (1 - discount.percent / 100)));
  return { ok: true, discount, finalPrice, originalPrice: service.price };
}

module.exports = { evaluate, GATEWAYS, todayKey };
