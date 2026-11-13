const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");

const db = require("./db");
const auth = require("./auth");
const availability = require("./availability");
const discounts = require("./discounts");
const moyasar = require("./moyasar");

const app = express();
app.disable("x-powered-by");
// Vercel's edge sits in front of this app as a proxy — trust its
// X-Forwarded-For so express-rate-limit keys by real client IP instead of
// rejecting the header as spoofable.
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- helpers ----------
function genRef() { return "HB-" + crypto.randomInt(1000, 9999); }
function isValidSaudiPhone(p) { return /^05\d{8}$/.test(String(p || "")); }
function isValidDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")); }
function isValidTime(s) { return /^\d{2}:\d{2}$/.test(String(s || "")); }
function clip(s, max) { return String(s || "").slice(0, max); }

// ---------- public API ----------
app.get("/api/services", ah(async (req, res) => {
  const data = await db.getData();
  res.json(data.services.filter(s => s.active));
}));

app.get("/api/branches", ah(async (req, res) => {
  res.json((await db.getData()).branches);
}));

app.get("/api/availability", ah(async (req, res) => {
  const { branch, year, month } = req.query;
  const data = await db.getData();
  if (!data.branches.some(b => b.id === branch)) return res.status(400).json({ error: "فرع غير صحيح" });
  const y = parseInt(year, 10), m = parseInt(month, 10);
  if (!y || !m || m < 1 || m > 12) return res.status(400).json({ error: "تاريخ غير صحيح" });
  res.json(availability.availabilityForMonth(data, branch, y, m));
}));

app.post("/api/discounts/check", ah(async (req, res) => {
  const { code, serviceId, pay } = req.body || {};
  const data = await db.getData();
  const result = discounts.evaluate(data, { code, serviceId, pay });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ percent: result.discount.percent, finalPrice: result.finalPrice, originalPrice: result.originalPrice });
}));

app.get("/api/payment-config", (req, res) => {
  res.json({ enabled: moyasar.enabled() });
});

// Lets the post-payment redirect page confirm real status from the server
// instead of trusting its own query string. Deliberately excludes phone,
// notes and health flags — this endpoint has no auth.
app.get("/api/bookings/ref/:ref", ah(async (req, res) => {
  const data = await db.getData();
  const b = data.bookings.find(x => x.ref === req.params.ref);
  if (!b) return res.status(404).json({ error: "الحجز غير موجود" });
  res.json({
    ref: b.ref, serviceName: b.serviceName, branchName: b.branchName,
    date: b.date, time: b.time, price: b.price, status: b.status, paid: !!b.paid
  });
}));

const bookingLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

app.post("/api/bookings", bookingLimiter, ah(async (req, res) => {
  const b = req.body || {};
  const data = await db.getData();

  // A logged-in customer's phone is authoritative — ignore whatever the
  // client sent for it, so bookings always attribute correctly to accounts.
  const customerId = await auth.getCustomerIdFromSession(req.cookies && req.cookies.customer_session);
  const customer = customerId ? data.customers.find(c => c.id === customerId) : null;

  const service = data.services.find(s => s.id === b.serviceId && s.active);
  const branch = data.branches.find(x => x.id === b.branch);
  if (!service) return res.status(400).json({ error: "خدمة غير صحيحة" });
  if (!branch) return res.status(400).json({ error: "فرع غير صحيح" });
  if (!isValidDate(b.date) || !isValidTime(b.time)) return res.status(400).json({ error: "موعد غير صحيح" });
  if (!availability.isSlotAvailable(data, b.branch, b.date, b.time)) {
    return res.status(409).json({ error: "هذا الموعد غير متاح، اختاري وقت آخر" });
  }
  const name = clip(b.name, 80).trim();
  if (name.length < 2) return res.status(400).json({ error: "اكتبي الاسم" });
  const phone = customer ? customer.phone : b.phone;
  if (!isValidSaudiPhone(phone)) return res.status(400).json({ error: "رقم جوال غير صحيح" });
  const notes = clip(b.notes, 400).trim();
  const health = Array.isArray(b.health) ? b.health.filter(n => Number.isInteger(n)).slice(0, 10) : [];
  const pay = ["tabby", "tamara", "card"].includes(b.pay) ? b.pay : "card";

  let price = service.price;
  let appliedDiscount = null;
  if (b.discountCode) {
    const result = discounts.evaluate(data, { code: b.discountCode, serviceId: service.id, pay });
    if (!result.ok) return res.status(400).json({ error: result.error });
    price = result.finalPrice;
    appliedDiscount = { code: result.discount.code, percent: result.discount.percent };
  }

  const booking = {
    id: crypto.randomUUID(),
    ref: genRef(),
    customerId: customer ? customer.id : null,
    serviceId: service.id,
    serviceName: service.name,
    price,
    originalPrice: service.price,
    discount: appliedDiscount,
    branch: branch.id,
    branchName: branch.name,
    date: b.date,
    time: b.time,
    name,
    phone,
    notes,
    health,
    pay,
    status: "pending",
    paid: false,
    moyasarInvoiceId: null,
    rescheduleRequested: false,
    createdAt: new Date().toISOString()
  };

  // Re-check availability inside the mutation to avoid a race between two
  // customers grabbing the same slot at the same moment.
  const result = await db.mutate(d => {
    if (!availability.isSlotAvailable(d, booking.branch, booking.date, booking.time)) return { conflict: true };
    d.bookings.push(booking);
    return { conflict: false };
  });

  if (result.conflict) return res.status(409).json({ error: "هذا الموعد غير متاح، اختاري وقت آخر" });

  if (!moyasar.enabled()) {
    return res.status(201).json({ ref: booking.ref, id: booking.id });
  }

  // The booking exists either way at this point — if invoice creation fails
  // here, the customer still has a pending booking and can be charged later
  // (e.g. by WhatsApp) rather than losing the slot they just grabbed.
  try {
    const baseUrl = req.protocol + "://" + req.get("host");
    const invoice = await moyasar.createInvoice({
      amountSar: price,
      description: `${service.name} — ${branch.name} — ${b.date} ${b.time}`,
      metadata: { bookingId: booking.id, ref: booking.ref },
      successUrl: `${baseUrl}/?paid_ref=${encodeURIComponent(booking.ref)}`,
      backUrl: `${baseUrl}/`
    });
    await db.mutate(d => {
      const bk = d.bookings.find(x => x.id === booking.id);
      if (bk) bk.moyasarInvoiceId = invoice.id;
    });
    res.status(201).json({ ref: booking.ref, id: booking.id, paymentUrl: invoice.url });
  } catch (e) {
    res.status(201).json({ ref: booking.ref, id: booking.id, paymentError: true });
  }
}));

app.post("/api/payments/webhook", ah(async (req, res) => {
  const { type, secret_token, data } = req.body || {};
  if (!moyasar.verifyWebhookSecret(secret_token)) return res.status(401).json({ error: "unauthorized" });
  if (!data || !data.invoice_id) return res.json({ ok: true }); // not an invoice payment; nothing to do

  if (type === "payment_paid") {
    await db.mutate(d => {
      const bk = d.bookings.find(x => x.moyasarInvoiceId === data.invoice_id);
      if (bk && !bk.paid) {
        bk.paid = true;
        bk.paidAt = new Date().toISOString();
        bk.status = "confirmed";
      }
    });
  } else if (type === "payment_refunded" || type === "payment_partially_refunded") {
    await db.mutate(d => {
      const bk = d.bookings.find(x => x.moyasarInvoiceId === data.invoice_id);
      if (bk) bk.refunded = true;
    });
  }
  res.json({ ok: true });
}));

// ---------- customer accounts ----------
function serializeCustomer(c) { return { id: c.id, name: c.name, phone: c.phone }; }
function hoursUntil(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [h, min] = timeStr.split(":").map(Number);
  const appt = new Date(y, m - 1, d, h, min);
  return (appt.getTime() - Date.now()) / 3600000;
}

const customerAuthLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const COOKIE_OPTS = { httpOnly: true, sameSite: "strict", maxAge: 12 * 60 * 60 * 1000 };

app.post("/api/customers/signup", customerAuthLimiter, ah(async (req, res) => {
  const { phone, password, name } = req.body || {};
  if (!isValidSaudiPhone(phone)) return res.status(400).json({ error: "رقم جوال غير صحيح" });
  if (!password || String(password).length < 6) return res.status(400).json({ error: "كلمة المرور يجب أن تكون ٦ خانات على الأقل" });
  const cleanName = clip(name, 80).trim();
  if (cleanName.length < 2) return res.status(400).json({ error: "اكتبي اسمك" });

  const data = await db.getData();
  if (data.customers.some(c => c.phone === phone)) {
    return res.status(409).json({ error: "فيه حساب مسجّل بهذا الرقم، سجّلي دخول بدل إنشاء حساب جديد" });
  }
  const customer = {
    id: crypto.randomUUID(), phone, name: cleanName,
    passwordHash: bcrypt.hashSync(String(password), 10),
    createdAt: new Date().toISOString()
  };
  await db.mutate(d => { d.customers.push(customer); });
  const token = await auth.createCustomerSession(customer.id);
  res.cookie("customer_session", token, Object.assign({ secure: req.secure }, COOKIE_OPTS));
  res.status(201).json({ customer: serializeCustomer(customer) });
}));

app.post("/api/customers/login", customerAuthLimiter, ah(async (req, res) => {
  const { phone, password } = req.body || {};
  const data = await db.getData();
  const customer = data.customers.find(c => c.phone === phone);
  if (!customer || !bcrypt.compareSync(String(password || ""), customer.passwordHash)) {
    return res.status(401).json({ error: "رقم الجوال أو كلمة المرور غير صحيحة" });
  }
  const token = await auth.createCustomerSession(customer.id);
  res.cookie("customer_session", token, Object.assign({ secure: req.secure }, COOKIE_OPTS));
  res.json({ customer: serializeCustomer(customer) });
}));

app.post("/api/customers/logout", ah(async (req, res) => {
  await auth.destroyCustomerSession(req.cookies && req.cookies.customer_session);
  res.clearCookie("customer_session");
  res.json({ ok: true });
}));

app.get("/api/customers/me", ah(async (req, res) => {
  const customerId = await auth.getCustomerIdFromSession(req.cookies && req.cookies.customer_session);
  if (!customerId) return res.json({ authenticated: false });
  const data = await db.getData();
  const customer = data.customers.find(c => c.id === customerId);
  if (!customer) return res.json({ authenticated: false });
  res.json({ authenticated: true, customer: serializeCustomer(customer) });
}));

app.get("/api/customers/bookings", ah(auth.requireCustomerAuth), ah(async (req, res) => {
  const data = await db.getData();
  const list = data.bookings
    .filter(b => b.customerId === req.customerId)
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
    .map(b => Object.assign({}, b, { canCancel: ["pending", "confirmed"].includes(b.status) && hoursUntil(b.date, b.time) >= 48, canRequestReschedule: ["pending", "confirmed"].includes(b.status) && hoursUntil(b.date, b.time) < 48 && hoursUntil(b.date, b.time) > 0 }));
  res.json(list);
}));

app.post("/api/customers/bookings/:id/cancel", ah(auth.requireCustomerAuth), ah(async (req, res) => {
  const result = await db.mutate(d => {
    const bk = d.bookings.find(x => x.id === req.params.id && x.customerId === req.customerId);
    if (!bk) return { notFound: true };
    if (!["pending", "confirmed"].includes(bk.status)) return { error: "هذا الحجز ما يقدر يتلغى" };
    if (hoursUntil(bk.date, bk.time) < 48) return { error: "الإلغاء متاح لين ٤٨ ساعة قبل الموعد فقط. تقدرين تطلبين تأجيل بدلاً منه." };
    bk.status = "cancelled";
    return { booking: bk };
  });
  if (result.notFound) return res.status(404).json({ error: "الحجز غير موجود" });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.booking);
}));

app.post("/api/customers/bookings/:id/request-reschedule", ah(auth.requireCustomerAuth), ah(async (req, res) => {
  const result = await db.mutate(d => {
    const bk = d.bookings.find(x => x.id === req.params.id && x.customerId === req.customerId);
    if (!bk) return { notFound: true };
    if (!["pending", "confirmed"].includes(bk.status)) return { error: "هذا الحجز ما يقدر يتأجل" };
    bk.rescheduleRequested = true;
    bk.rescheduleRequestedAt = new Date().toISOString();
    return { booking: bk };
  });
  if (result.notFound) return res.status(404).json({ error: "الحجز غير موجود" });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.booking);
}));

// ---------- admin auth ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

app.post("/api/admin/login", loginLimiter, ah(async (req, res) => {
  const { password } = req.body || {};
  if (!await auth.verifyPassword(password)) return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  const token = await auth.createSession();
  res.cookie("admin_session", token, {
    httpOnly: true, sameSite: "strict", secure: req.secure, maxAge: 12 * 60 * 60 * 1000
  });
  res.json({ ok: true });
}));

app.post("/api/admin/logout", ah(async (req, res) => {
  await auth.destroySession(req.cookies && req.cookies.admin_session);
  res.clearCookie("admin_session");
  res.json({ ok: true });
}));

app.get("/api/admin/me", ah(async (req, res) => {
  const ok = await auth.touchSession(req.cookies && req.cookies.admin_session);
  res.json({ authenticated: ok });
}));

app.use("/api/admin", (req, res, next) => {
  if (req.path === "/login" || req.path === "/logout" || req.path === "/me") return next();
  return ah(auth.requireAuth)(req, res, next);
});

app.put("/api/admin/password", ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!await auth.verifyPassword(currentPassword)) return res.status(401).json({ error: "كلمة المرور الحالية غير صحيحة" });
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: "كلمة المرور الجديدة يجب أن تكون ٦ خانات على الأقل" });
  await auth.setPassword(newPassword);
  res.json({ ok: true });
}));

// ---------- admin: bookings ----------
app.get("/api/admin/bookings", ah(async (req, res) => {
  const { status, branch, q } = req.query;
  const data = await db.getData();
  let list = data.bookings.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  if (status && status !== "all") list = list.filter(b => b.status === status);
  if (branch && branch !== "all") list = list.filter(b => b.branch === branch);
  if (q) {
    const needle = String(q).trim();
    list = list.filter(b => b.phone.includes(needle) || b.name.includes(needle) || b.ref.includes(needle));
  }
  res.json(list);
}));

app.patch("/api/admin/bookings/:id", ah(async (req, res) => {
  const { status } = req.body || {};
  if (!["pending", "confirmed", "cancelled", "done"].includes(status)) return res.status(400).json({ error: "حالة غير صحيحة" });
  const result = await db.mutate(d => {
    const bk = d.bookings.find(x => x.id === req.params.id);
    if (!bk) return { notFound: true };
    bk.status = status;
    return { booking: bk };
  });
  if (result.notFound) return res.status(404).json({ error: "الحجز غير موجود" });
  res.json(result.booking);
}));

// ---------- admin: schedule & overrides ----------
app.get("/api/admin/schedule", ah(async (req, res) => {
  const data = await db.getData();
  res.json({ schedule: data.schedule, overrides: data.overrides, branches: data.branches });
}));

app.put("/api/admin/schedule", ah(async (req, res) => {
  const { branch, weekdays, slots, capacity } = req.body || {};
  const data = await db.getData();
  if (!data.branches.some(b => b.id === branch)) return res.status(400).json({ error: "فرع غير صحيح" });
  if (!Array.isArray(weekdays) || !weekdays.every(n => Number.isInteger(n) && n >= 0 && n <= 6)) return res.status(400).json({ error: "أيام غير صحيحة" });
  if (!Array.isArray(slots) || !slots.every(isValidTime) || !slots.length) return res.status(400).json({ error: "لازم وقت واحد على الأقل بصيغة صحيحة" });
  const cap = Math.max(1, parseInt(capacity, 10) || 1);
  await db.mutate(d => {
    d.schedule[branch] = { weekdays: [...new Set(weekdays)].sort(), slots: [...new Set(slots)].sort(), capacity: cap };
  });
  res.json({ ok: true });
}));

app.post("/api/admin/overrides", ah(async (req, res) => {
  const { branch, date, closed, slots } = req.body || {};
  const data = await db.getData();
  if (!data.branches.some(b => b.id === branch)) return res.status(400).json({ error: "فرع غير صحيح" });
  if (!isValidDate(date)) return res.status(400).json({ error: "تاريخ غير صحيح" });
  if (!closed && (!Array.isArray(slots) || !slots.every(isValidTime))) return res.status(400).json({ error: "أوقات غير صحيحة" });
  await db.mutate(d => {
    if (!d.overrides[branch]) d.overrides[branch] = {};
    d.overrides[branch][date] = closed ? { closed: true } : { slots: [...new Set(slots)].sort() };
  });
  res.json({ ok: true });
}));

app.delete("/api/admin/overrides/:branch/:date", ah(async (req, res) => {
  const { branch, date } = req.params;
  await db.mutate(d => { if (d.overrides[branch]) delete d.overrides[branch][date]; });
  res.json({ ok: true });
}));

// ---------- admin: services ----------
app.get("/api/admin/services", ah(async (req, res) => {
  res.json((await db.getData()).services);
}));

app.put("/api/admin/services/:id", ah(async (req, res) => {
  const { name, en, price, desc, active } = req.body || {};
  const result = await db.mutate(d => {
    const s = d.services.find(x => x.id === req.params.id);
    if (!s) return { notFound: true };
    if (name !== undefined) s.name = clip(name, 60);
    if (en !== undefined) s.en = clip(en, 60);
    if (desc !== undefined) s.desc = clip(desc, 300);
    if (price !== undefined) s.price = Math.max(0, Number(price) || 0);
    if (active !== undefined) s.active = !!active;
    return { service: s };
  });
  if (result.notFound) return res.status(404).json({ error: "الخدمة غير موجودة" });
  res.json(result.service);
}));

// ---------- admin: discount codes ----------
app.get("/api/admin/discounts", ah(async (req, res) => {
  res.json((await db.getData()).discounts);
}));

function validateDiscountPayload(body, services) {
  const code = clip(body.code, 30).trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) return { error: "كود غير صحيح، استخدمي حروف إنجليزية وأرقام فقط (٣ خانات على الأقل)" };
  const percent = Number(body.percent);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 90) return { error: "نسبة الخصم يجب أن تكون بين ١ و ٩٠٪" };
  if (!discounts.GATEWAYS.includes(body.gateway)) return { error: "بوابة دفع غير صحيحة" };
  let serviceIds = body.serviceIds;
  if (!Array.isArray(serviceIds) || !serviceIds.length) return { error: "اختاري خدمة واحدة على الأقل أو الكل" };
  if (!serviceIds.includes("all") && !serviceIds.every(id => services.some(s => s.id === id))) {
    return { error: "خدمة غير صحيحة ضمن القائمة" };
  }
  if (body.startDate && !isValidDate(body.startDate)) return { error: "تاريخ بداية غير صحيح" };
  if (body.endDate && !isValidDate(body.endDate)) return { error: "تاريخ نهاية غير صحيح" };
  if (body.startDate && body.endDate && body.startDate > body.endDate) return { error: "تاريخ البداية بعد تاريخ النهاية" };
  return {
    value: {
      code, percent, gateway: body.gateway, serviceIds,
      startDate: body.startDate || null, endDate: body.endDate || null,
      active: body.active === undefined ? true : !!body.active
    }
  };
}

app.post("/api/admin/discounts", ah(async (req, res) => {
  const data = await db.getData();
  const { value, error } = validateDiscountPayload(req.body || {}, data.services);
  if (error) return res.status(400).json({ error });
  if (data.discounts.some(d => d.code === value.code)) return res.status(409).json({ error: "هذا الكود موجود مسبقاً" });
  const discount = Object.assign({ id: crypto.randomUUID() }, value);
  await db.mutate(d => { d.discounts.push(discount); });
  res.status(201).json(discount);
}));

app.put("/api/admin/discounts/:id", ah(async (req, res) => {
  const data = await db.getData();
  const existing = data.discounts.find(d => d.id === req.params.id);
  if (!existing) return res.status(404).json({ error: "الكود غير موجود" });
  const { value, error } = validateDiscountPayload(req.body || {}, data.services);
  if (error) return res.status(400).json({ error });
  if (value.code !== existing.code && data.discounts.some(d => d.code === value.code)) {
    return res.status(409).json({ error: "هذا الكود موجود مسبقاً" });
  }
  const result = await db.mutate(d => {
    const disc = d.discounts.find(x => x.id === req.params.id);
    Object.assign(disc, value);
    return disc;
  });
  res.json(result);
}));

app.delete("/api/admin/discounts/:id", ah(async (req, res) => {
  await db.mutate(d => { d.discounts = d.discounts.filter(x => x.id !== req.params.id); });
  res.json({ ok: true });
}));

// ---------- static sites ----------
app.use("/admin", express.static(path.join(__dirname, "..", "admin")));
app.use("/", express.static(path.join(__dirname, "..", "public")));

// ---------- error handling ----------
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: "حصل خطأ في الخادم" });
});

module.exports = app;
