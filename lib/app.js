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
const tabby = require("./tabby");
const tamara = require("./tamara");

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

// ---------- retouch eligibility ----------
const RETOUCH_SERVICES = ["mb", "ms"];
const RETOUCH_MIN_DAYS = 25, RETOUCH_IDEAL_MAX_DAYS = 36, RETOUCH_MAX_DAYS = 365;

function daysSinceDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const then = new Date(y, m - 1, d);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.floor((now - then) / 86400000);
}

// Self-service retouch eligibility for a single original booking — only
// shown to the admin and to the customer who owns it. Returns null when the
// booking could never qualify (wrong service, or not completed yet).
function retouchInfoFor(data, booking) {
  if (!RETOUCH_SERVICES.includes(booking.serviceId) || booking.status !== "done") return null;
  const alreadyBooked = data.bookings.some(x => x.retouchForBookingId === booking.id && x.status !== "cancelled");
  const days = daysSinceDate(booking.date);
  return {
    alreadyBooked,
    daysSince: days,
    eligible: !alreadyBooked && days >= RETOUCH_MIN_DAYS && days <= RETOUCH_MAX_DAYS,
    ideal: days <= RETOUCH_IDEAL_MAX_DAYS
  };
}

// ---------- public API ----------
app.get("/api/services", ah(async (req, res) => {
  const data = await db.getData();
  res.json(data.services.filter(s => s.active && !s.hidden));
}));

app.get("/api/branches", ah(async (req, res) => {
  res.json((await db.getData()).branches);
}));

app.get("/api/availability", ah(async (req, res) => {
  const { branch, year, month, serviceId } = req.query;
  const data = await db.getData();
  if (!data.branches.some(b => b.id === branch)) return res.status(400).json({ error: "فرع غير صحيح" });
  const y = parseInt(year, 10), m = parseInt(month, 10);
  if (!y || !m || m < 1 || m > 12) return res.status(400).json({ error: "تاريخ غير صحيح" });
  const svc = data.services.find(s => s.id === serviceId);
  res.json(availability.availabilityForMonth(data, branch, y, m, svc ? svc.id : undefined));
}));

app.post("/api/discounts/check", ah(async (req, res) => {
  const { code, serviceId, pay } = req.body || {};
  const data = await db.getData();
  const result = discounts.evaluate(data, { code, serviceId, pay });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ percent: result.discount.percent, finalPrice: result.finalPrice, originalPrice: result.originalPrice });
}));

app.get("/api/payment-config", (req, res) => {
  res.json({ tabby: tabby.enabled() });
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

  // Booking requires a signed-in account — no more guest checkout. The
  // customer's own phone on file is authoritative, never whatever the
  // client sent, so a booking always attributes correctly to its account.
  const customerId = await auth.getCustomerIdFromSession(req.cookies && req.cookies.customer_session);
  const customer = customerId ? data.customers.find(c => c.id === customerId) : null;
  if (!customer) return res.status(401).json({ error: "تحتاجين تسجيل الدخول للحجز" });

  const service = data.services.find(s => s.id === b.serviceId && s.active && !s.hidden);
  const branch = data.branches.find(x => x.id === b.branch);
  if (!service) return res.status(400).json({ error: "خدمة غير صحيحة" });
  if (!branch) return res.status(400).json({ error: "فرع غير صحيح" });
  if (!isValidDate(b.date) || !isValidTime(b.time)) return res.status(400).json({ error: "موعد غير صحيح" });
  if (!availability.isSlotAvailable(data, b.branch, b.date, b.time, service.id)) {
    return res.status(409).json({ error: "هذا الموعد غير متاح، اختاري وقت آخر" });
  }
  const name = clip(b.name, 80).trim();
  if (name.length < 2) return res.status(400).json({ error: "اكتبي الاسم" });
  const phone = customer.phone;
  const notes = clip(b.notes, 400).trim();
  const health = Array.isArray(b.health) ? b.health.filter(n => Number.isInteger(n)).slice(0, 10) : [];
  const pay = ["tabby", "bank", "cash"].includes(b.pay) ? b.pay : "cash";

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
    gateway: null,
    tabbySessionId: null,
    tabbyPaymentId: null,
    tamaraOrderId: null,
    rescheduleRequested: false,
    createdAt: new Date().toISOString()
  };

  // Re-check availability inside the mutation to avoid a race between two
  // customers grabbing the same slot at the same moment.
  const result = await db.mutate(d => {
    if (!availability.isSlotAvailable(d, booking.branch, booking.date, booking.time, booking.serviceId)) return { conflict: true };
    d.bookings.push(booking);
    return { conflict: false };
  });

  if (result.conflict) return res.status(409).json({ error: "هذا الموعد غير متاح، اختاري وقت آخر" });

  // Cash and bank transfer are always manual/offline — the booking is simply
  // saved as pending and staff follow up (in person, or on WhatsApp with
  // transfer details) to confirm payment. No gateway involved, ever.
  if (pay === "cash" || pay === "bank") return res.status(201).json({ ref: booking.ref, id: booking.id });

  // Tabby approval still pending for this merchant — keep today's behavior:
  // booking stays pending, no redirect, business follows up manually.
  if (!tabby.enabled()) return res.status(201).json({ ref: booking.ref, id: booking.id });

  const baseUrl = req.protocol + "://" + req.get("host");
  const description = `${service.name} — ${branch.name} — ${b.date} ${b.time}`;
  const successUrl = `${baseUrl}/?paid_ref=${encodeURIComponent(booking.ref)}`;
  const cancelUrl = `${baseUrl}/`;

  // The booking exists either way at this point — if the gateway call fails
  // here, the customer still has a pending booking and can be charged later
  // (e.g. by WhatsApp) rather than losing the slot they just grabbed.
  try {
    const session = await tabby.createSession({
      amountSar: price, description, name, phone, dob: customer.dob, bookingRef: booking.ref,
      successUrl, cancelUrl, failureUrl: cancelUrl
    });
    await db.mutate(d => {
      const bk = d.bookings.find(x => x.id === booking.id);
      if (bk) Object.assign(bk, { gateway: "tabby", tabbySessionId: session.sessionId, tabbyPaymentId: session.paymentId });
    });
    res.status(201).json({ ref: booking.ref, id: booking.id, paymentUrl: session.url });
  } catch (e) {
    res.status(201).json({ ref: booking.ref, id: booking.id, paymentError: true });
  }
}));

app.post("/api/payments/tabby-webhook", ah(async (req, res) => {
  if (!tabby.verifyWebhookHeader(req.get("X-Webhook-Secret"))) return res.status(401).json({ error: "unauthorized" });
  const { status, id: paymentId } = req.body || {};
  if (status === "authorized") {
    const data = await db.getData();
    const bk = data.bookings.find(x => x.tabbyPaymentId === paymentId);
    if (bk && !bk.paid) {
      try {
        await tabby.capture(paymentId, bk.price);
        await db.mutate(d => {
          const b2 = d.bookings.find(x => x.id === bk.id);
          if (b2) { b2.paid = true; b2.paidAt = new Date().toISOString(); b2.status = "confirmed"; }
        });
      } catch (e) { /* capture failed — booking stays pending for manual follow-up */ }
    }
  }
  res.json({ ok: true });
}));

app.post("/api/payments/tamara-webhook", ah(async (req, res) => {
  const jwtFromQuery = req.query.tamaraToken;
  const jwtFromHeader = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tamara.verifyWebhookJwt(jwtFromQuery || jwtFromHeader)) return res.status(401).json({ error: "unauthorized" });
  const { event_type, order_id } = req.body || {};
  if (event_type === "order_approved") {
    const data = await db.getData();
    const bk = data.bookings.find(x => x.tamaraOrderId === order_id);
    if (bk && !bk.paid) {
      try {
        await tamara.authoriseOrder(order_id);
        await db.mutate(d => {
          const b2 = d.bookings.find(x => x.id === bk.id);
          if (b2) { b2.paid = true; b2.paidAt = new Date().toISOString(); b2.status = "confirmed"; }
        });
      } catch (e) { /* authorise failed — booking stays pending for manual follow-up */ }
    }
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

function isValidDob(s) {
  if (!isValidDate(s)) return false;
  const d = new Date(s);
  const ageMs = Date.now() - d.getTime();
  const age = ageMs / (365.25 * 24 * 3600 * 1000);
  return age >= 10 && age <= 110;
}

app.post("/api/customers/signup", customerAuthLimiter, ah(async (req, res) => {
  const { phone, password, name, dob } = req.body || {};
  if (!isValidSaudiPhone(phone)) return res.status(400).json({ error: "رقم جوال غير صحيح" });
  if (!password || String(password).length < 6) return res.status(400).json({ error: "كلمة المرور يجب أن تكون ٦ خانات على الأقل" });
  const cleanName = clip(name, 80).trim();
  if (cleanName.length < 2) return res.status(400).json({ error: "اكتبي اسمك" });
  if (!isValidDob(dob)) return res.status(400).json({ error: "تاريخ ميلاد غير صحيح" });

  const data = await db.getData();
  if (data.customers.some(c => c.phone === phone)) {
    return res.status(409).json({ error: "يوجد حساب مسجَّل بهذا الرقم، يُرجى تسجيل الدخول بدلاً من إنشاء حساب جديد" });
  }
  const customer = {
    id: crypto.randomUUID(), phone, name: cleanName, dob,
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
    .map(b => Object.assign({}, b, {
      canCancel: ["pending", "confirmed"].includes(b.status) && hoursUntil(b.date, b.time) >= 48,
      canRequestReschedule: ["pending", "confirmed"].includes(b.status) && hoursUntil(b.date, b.time) < 48 && hoursUntil(b.date, b.time) > 0,
      retouch: retouchInfoFor(data, b)
    }));
  res.json(list);
}));

// Free retouch session for a customer's own completed microblading/
// microshading booking — eligibility is re-verified here against the
// booking record itself, never trusted from the client.
app.post("/api/customers/bookings/retouch", ah(auth.requireCustomerAuth), ah(async (req, res) => {
  const { bookingId, date, time } = req.body || {};
  const data = await db.getData();
  const orig = data.bookings.find(x => x.id === bookingId && x.customerId === req.customerId);
  if (!orig) return res.status(404).json({ error: "الحجز الأصلي غير موجود" });
  const info = retouchInfoFor(data, orig);
  if (!info) return res.status(400).json({ error: "جلسة الرتوش المجانية متاحة فقط لعميلات المايكروبليدينق والمايكروشيدينق بعد اكتمال الجلسة" });
  if (info.alreadyBooked) return res.status(400).json({ error: "تم حجز جلسة الرتوش لهذا الموعد مسبقاً" });
  if (info.daysSince < RETOUCH_MIN_DAYS) return res.status(400).json({ error: `جلسة الرتوش تُتاح بعد مرور ${RETOUCH_MIN_DAYS} يوماً على الأقل من الجلسة الأساسية` });
  if (info.daysSince > RETOUCH_MAX_DAYS) return res.status(400).json({ error: "انتهت مدة أحقية جلسة الرتوش المجانية" });
  if (!isValidDate(date) || !isValidTime(time)) return res.status(400).json({ error: "موعد غير صحيح" });
  if (!availability.isSlotAvailable(data, orig.branch, date, time, "retouch")) return res.status(409).json({ error: "هذا الموعد غير متاح، اختاري وقتاً آخر" });

  const branch = data.branches.find(x => x.id === orig.branch);
  const customer = data.customers.find(c => c.id === req.customerId);
  const booking = {
    id: crypto.randomUUID(), ref: genRef(), customerId: req.customerId,
    serviceId: "retouch", serviceName: "جلسة الرتوش", price: 0, originalPrice: 0, discount: null,
    branch: orig.branch, branchName: branch.name, date, time,
    name: customer.name, phone: customer.phone, notes: "", health: [],
    pay: "cash", status: "pending", paid: false, gateway: null,
    retouchForBookingId: orig.id,
    tabbySessionId: null, tabbyPaymentId: null, tamaraOrderId: null,
    rescheduleRequested: false, createdAt: new Date().toISOString()
  };
  const result = await db.mutate(d => {
    if (!availability.isSlotAvailable(d, booking.branch, booking.date, booking.time, "retouch")) return { conflict: true };
    d.bookings.push(booking);
    return { conflict: false };
  });
  if (result.conflict) return res.status(409).json({ error: "هذا الموعد غير متاح، اختاري وقتاً آخر" });
  res.status(201).json({ ref: booking.ref, id: booking.id });
}));

app.post("/api/customers/bookings/:id/cancel", ah(auth.requireCustomerAuth), ah(async (req, res) => {
  const result = await db.mutate(d => {
    const bk = d.bookings.find(x => x.id === req.params.id && x.customerId === req.customerId);
    if (!bk) return { notFound: true };
    if (!["pending", "confirmed"].includes(bk.status)) return { error: "لا يمكن إلغاء هذا الحجز" };
    if (hoursUntil(bk.date, bk.time) < 48) return { error: "الإلغاء متاح حتى 48 ساعة قبل الموعد فقط. يمكنك طلب التأجيل بدلاً من ذلك." };
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
    if (!["pending", "confirmed"].includes(bk.status)) return { error: "لا يمكن تأجيل هذا الحجز" };
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
  res.json(list.map(b => Object.assign({}, b, { retouch: retouchInfoFor(data, b) })));
}));

// A booking the admin records by hand after agreeing details over WhatsApp —
// never goes through online availability/capacity checks (she already knows
// what she can actually fit), but still counts as busy time for everyone
// else's online availability afterward. retouchForBookingId lets her attach
// a retouch to any past booking at any time, bypassing the self-service
// eligibility window entirely.
app.post("/api/admin/bookings", ah(async (req, res) => {
  const b = req.body || {};
  const data = await db.getData();
  const service = data.services.find(s => s.id === b.serviceId && s.active);
  const branch = data.branches.find(x => x.id === b.branch);
  if (!service) return res.status(400).json({ error: "خدمة غير صحيحة" });
  if (!branch) return res.status(400).json({ error: "فرع غير صحيح" });
  if (!isValidDate(b.date) || !isValidTime(b.time)) return res.status(400).json({ error: "موعد غير صحيح" });
  const name = clip(b.name, 80).trim();
  if (name.length < 2) return res.status(400).json({ error: "الاسم مطلوب" });
  if (!isValidSaudiPhone(b.phone)) return res.status(400).json({ error: "رقم جوال غير صحيح" });

  let retouchForBookingId = null;
  if (service.id === "retouch" && b.retouchForBookingId) {
    const orig = data.bookings.find(x => x.id === b.retouchForBookingId);
    if (!orig) return res.status(400).json({ error: "الحجز الأصلي غير موجود" });
    retouchForBookingId = orig.id;
  }

  const existingCustomer = data.customers.find(c => c.phone === b.phone);

  const booking = {
    id: crypto.randomUUID(), ref: genRef(), customerId: existingCustomer ? existingCustomer.id : null,
    serviceId: service.id, serviceName: service.name,
    price: service.id === "retouch" ? 0 : service.price, originalPrice: service.price, discount: null,
    branch: branch.id, branchName: branch.name, date: b.date, time: b.time,
    name, phone: b.phone, notes: clip(b.notes, 400).trim(), health: [],
    pay: b.pay === "bank" ? "bank" : "cash",
    status: ["pending", "confirmed", "done"].includes(b.status) ? b.status : "confirmed",
    paid: !!b.paid, gateway: null, retouchForBookingId,
    tabbySessionId: null, tabbyPaymentId: null, tamaraOrderId: null,
    rescheduleRequested: false, createdAt: new Date().toISOString(),
    source: "admin"
  };
  await db.mutate(d => { d.bookings.push(booking); });
  res.status(201).json(booking);
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

app.delete("/api/admin/bookings/:id", ah(async (req, res) => {
  const result = await db.mutate(d => {
    const i = d.bookings.findIndex(x => x.id === req.params.id);
    if (i === -1) return { notFound: true };
    d.bookings.splice(i, 1);
    return { ok: true };
  });
  if (result.notFound) return res.status(404).json({ error: "الحجز غير موجود" });
  res.json({ ok: true });
}));

// ---------- admin: schedule & overrides ----------
app.get("/api/admin/schedule", ah(async (req, res) => {
  const data = await db.getData();
  res.json({ schedule: data.schedule, overrides: data.overrides, branches: data.branches });
}));

function isValidRange(r) {
  return r && isValidTime(r.from) && isValidTime(r.to) && r.from < r.to;
}

app.put("/api/admin/schedule", ah(async (req, res) => {
  const { branch, ranges, capacity } = req.body || {};
  const data = await db.getData();
  if (!data.branches.some(b => b.id === branch)) return res.status(400).json({ error: "فرع غير صحيح" });
  if (!ranges || typeof ranges !== "object") return res.status(400).json({ error: "جدول غير صحيح" });
  const clean = {};
  for (const key of Object.keys(ranges)) {
    const wd = Number(key);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) return res.status(400).json({ error: "يوم غير صحيح" });
    if (!isValidRange(ranges[key])) return res.status(400).json({ error: "وقت غير صحيح — تأكدي أن وقت البداية قبل وقت النهاية" });
    clean[wd] = { from: ranges[key].from, to: ranges[key].to };
  }
  const cap = Math.max(1, parseInt(capacity, 10) || 1);
  await db.mutate(d => {
    d.schedule[branch] = { ranges: clean, capacity: cap };
  });
  res.json({ ok: true });
}));

app.post("/api/admin/overrides", ah(async (req, res) => {
  const { branch, date, closed, range } = req.body || {};
  const data = await db.getData();
  if (!data.branches.some(b => b.id === branch)) return res.status(400).json({ error: "فرع غير صحيح" });
  if (!isValidDate(date)) return res.status(400).json({ error: "تاريخ غير صحيح" });
  if (!closed && !isValidRange(range)) return res.status(400).json({ error: "وقت غير صحيح" });
  await db.mutate(d => {
    if (!d.overrides[branch]) d.overrides[branch] = {};
    d.overrides[branch][date] = closed ? { closed: true } : { range: { from: range.from, to: range.to } };
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
  const { name, en, price, desc, active, durationMin } = req.body || {};
  const result = await db.mutate(d => {
    const s = d.services.find(x => x.id === req.params.id);
    if (!s) return { notFound: true };
    if (name !== undefined) s.name = clip(name, 60);
    if (en !== undefined) s.en = clip(en, 60);
    if (desc !== undefined) s.desc = clip(desc, 300);
    if (price !== undefined) s.price = Math.max(0, Number(price) || 0);
    if (active !== undefined) s.active = !!active;
    if (durationMin !== undefined) s.durationMin = Math.max(5, Number(durationMin) || s.durationMin);
    return { service: s };
  });
  if (result.notFound) return res.status(404).json({ error: "الخدمة غير موجودة" });
  res.json(result.service);
}));

// ---------- offers (promotional banner) ----------
// The public ticker reads only the single currently-active offer, if any —
// no auth needed, this is marketing copy, not sensitive data.
app.get("/api/offers/active", ah(async (req, res) => {
  const data = await db.getData();
  const today = discounts.todayKey();
  const offer = (data.offers || []).find(o => o.active && (!o.startDate || today >= o.startDate) && (!o.endDate || today <= o.endDate));
  res.json(offer ? { text: offer.text } : null);
}));

app.get("/api/admin/offers", ah(async (req, res) => {
  res.json((await db.getData()).offers || []);
}));

function validateOfferPayload(body) {
  const text = clip(body.text, 200).trim();
  if (!text) return { error: "اكتبي نص العرض" };
  if (body.startDate && !isValidDate(body.startDate)) return { error: "تاريخ بداية غير صحيح" };
  if (body.endDate && !isValidDate(body.endDate)) return { error: "تاريخ نهاية غير صحيح" };
  if (body.startDate && body.endDate && body.startDate > body.endDate) return { error: "تاريخ البداية بعد تاريخ النهاية" };
  return { value: { text, startDate: body.startDate || null, endDate: body.endDate || null, active: body.active === undefined ? true : !!body.active } };
}

app.post("/api/admin/offers", ah(async (req, res) => {
  const { value, error } = validateOfferPayload(req.body || {});
  if (error) return res.status(400).json({ error });
  const offer = Object.assign({ id: crypto.randomUUID() }, value);
  await db.mutate(d => { d.offers.push(offer); });
  res.status(201).json(offer);
}));

app.put("/api/admin/offers/:id", ah(async (req, res) => {
  const { value, error } = validateOfferPayload(req.body || {});
  if (error) return res.status(400).json({ error });
  const result = await db.mutate(d => {
    const o = d.offers.find(x => x.id === req.params.id);
    if (!o) return { notFound: true };
    Object.assign(o, value);
    return { offer: o };
  });
  if (result.notFound) return res.status(404).json({ error: "العرض غير موجود" });
  res.json(result.offer);
}));

app.delete("/api/admin/offers/:id", ah(async (req, res) => {
  const result = await db.mutate(d => {
    const i = d.offers.findIndex(x => x.id === req.params.id);
    if (i === -1) return { notFound: true };
    d.offers.splice(i, 1);
    return { ok: true };
  });
  if (result.notFound) return res.status(404).json({ error: "العرض غير موجود" });
  res.json({ ok: true });
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
  res.status(500).json({ error: "حدث خطأ في الخادم" });
});

module.exports = app;
