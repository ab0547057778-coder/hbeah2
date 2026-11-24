const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtN = n => Number(n).toLocaleString("en-US");
const dShort = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "short" });
const t12 = s => { let [h, m] = s.split(":").map(Number); const p = h >= 12 ? "م" : "ص"; h = h % 12 || 12; return h + ":" + String(m).padStart(2, "0") + " " + p; };
const WD_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
// Same list and order as public/app.js's HEALTH array, so a booking's stored
// health indices can be shown to the admin by name instead of a bare flag.
const HEALTH_LABELS = ["داء السكري", "ارتفاع أو انخفاض في ضغط الدم", "استخدام أدوية سيولة الدم", "التهاب أو مشكلة جلدية في المنطقة", "حساسية تجاه الأصبغة", "وشم أو مايكروبليدينق سابق للحواجب"];
// JS getDay(): 0=Sunday..6=Saturday, displayed Sat-first to match the public calendar.
const WD_ORDER = [6, 0, 1, 2, 3, 4, 5];

async function api(path, opts) {
  const res = await fetch("/api" + path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
  let data = null; try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || "حصل خطأ، حاولي مرة أخرى");
  return data;
}
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.remove("show"), 2200);
}

let BRANCHES = [];
let SERVICES_ALL = [];
let scheduleState = null; // {schedule, overrides, branches}
let currentBranch = null;

// ---------- modal ----------
const modalOverlay = document.getElementById("modal-overlay");
function openModal(title, bodyHtml) {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = bodyHtml;
  modalOverlay.classList.add("open");
}
function closeModal() { modalOverlay.classList.remove("open"); }
document.getElementById("modal-close").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", e => { if (e.target === modalOverlay) closeModal(); });

// ---------- auth ----------
async function checkSession() {
  const { authenticated } = await api("/admin/me");
  if (authenticated) showApp(); else showLogin();
}
function showLogin() {
  document.getElementById("login-screen").style.display = "grid";
  document.getElementById("app").style.display = "none";
}
function showApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display = "block";
  boot();
}
document.getElementById("login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const err = document.getElementById("login-err");
  err.classList.remove("show");
  try {
    await api("/admin/login", { method: "POST", body: JSON.stringify({ password: document.getElementById("pw").value }) });
    document.getElementById("pw").value = "";
    showApp();
  } catch (e2) {
    err.textContent = e2.message; err.classList.add("show");
  }
});
document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/admin/logout", { method: "POST" });
  showLogin();
});

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(x => x.classList.toggle("on", x === t));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("on", v.id === "view-" + t.dataset.view));
}));

let booted = false;
async function boot() {
  if (booted) { loadBookings(); return; }
  booted = true;
  BRANCHES = await api("/branches");
  const bSel = document.getElementById("f-branch");
  BRANCHES.forEach(b => bSel.insertAdjacentHTML("beforeend", `<option value="${b.id}">${esc(b.name)}</option>`));
  document.getElementById("schedule-branch-tabs").innerHTML = BRANCHES.map((b, i) =>
    `<button class="btn ${i ? "btn-ghost" : ""} btn-sm" data-branch="${b.id}">${esc(b.name)}</button>`).join("");
  currentBranch = BRANCHES[0] && BRANCHES[0].id;
  document.querySelectorAll("#schedule-branch-tabs [data-branch]").forEach(btn => btn.addEventListener("click", () => {
    currentBranch = btn.dataset.branch;
    ovSelected = null;
    document.querySelectorAll("#schedule-branch-tabs [data-branch]").forEach(b => b.classList.toggle("btn-ghost", b !== btn));
    renderSchedule();
  }));

  loadBookings();
  loadSchedule();
  loadServices();
  loadDiscounts();
  loadOffers();
}

// ---------- bookings ----------
let bookingsCache = [];
async function loadBookings() {
  const params = new URLSearchParams({
    status: document.getElementById("f-status").value,
    branch: document.getElementById("f-branch").value,
    q: document.getElementById("f-q").value
  });
  bookingsCache = await api("/admin/bookings?" + params.toString());
  renderBookings();
}
function statusLabel(s) { return { pending: "قيد الانتظار", confirmed: "مؤكد", cancelled: "ملغي", done: "مكتمل" }[s] || s; }
function renderBookings() {
  const body = document.getElementById("bookings-body");
  const empty = document.getElementById("bookings-empty");
  if (!bookingsCache.length) { body.innerHTML = ""; empty.style.display = "block"; return; }
  empty.style.display = "none";
  body.innerHTML = bookingsCache.map(b => {
    const waMsg = encodeURIComponent(`مرحباً ${b.name}، بخصوص حجزك رقم ${b.ref} يوم ${b.date} ${t12(b.time)}`);
    const actions = [];
    if (b.status !== "confirmed") actions.push(`<button class="btn btn-ghost btn-sm" data-act="confirmed" data-id="${b.id}">تأكيد</button>`);
    if (b.status !== "done") actions.push(`<button class="btn btn-ghost btn-sm" data-act="done" data-id="${b.id}">مكتمل</button>`);
    if (b.status !== "cancelled") actions.push(`<button class="btn btn-ghost btn-sm" data-act="cancelled" data-id="${b.id}">إلغاء</button>`);
    actions.push(`<a class="btn btn-ghost btn-sm" href="https://wa.me/966${b.phone.slice(1)}?text=${waMsg}" target="_blank" rel="noopener">واتساب</a>`);
    if (b.retouch && !b.retouch.alreadyBooked) actions.push(`<button class="btn btn-ghost btn-sm" data-retouch="${b.id}">+ حجز رتوش</button>`);
    actions.push(`<button class="btn btn-ghost btn-sm" data-del="${b.id}" style="color:var(--bad)">حذف نهائي</button>`);
    let retouchInfo = "";
    if (b.retouch) {
      retouchInfo = b.retouch.alreadyBooked
        ? '<div class="retouch-info">تم حجز جلسة الرتوش لهذا الموعد.</div>'
        : `<div class="retouch-info">أهلية الرتوش المجانية: اليوم ${b.retouch.daysSince} منذ الجلسة${b.retouch.eligible ? (b.retouch.ideal ? " — <b>ضمن الفترة المثلى (٢٥-٣٦ يوماً)</b>" : " — ضمن فترة الأحقية") : b.retouch.daysSince < 25 ? " — لم تصل بعد لفترة الأحقية (تبدأ من اليوم ٢٥)" : " — انتهت فترة الأحقية (تجاوزت سنة)"}</div>`;
    }
    return `<tr data-id="${b.id}">
      <td class="bk-summary-cell" data-toggle>
        <span class="bk-name">${esc(b.name)}${b.source === "admin" ? '<span class="source-badge">واتساب</span>' : ""}</span>
        <svg class="bk-chevron" viewBox="0 0 24 24" width="18" height="18"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </td>
      <td class="bk-detail" data-label=""><span class="latin" dir="ltr" style="font-weight:600;font-size:15px">${esc(b.ref)}</span></td>
      <td class="bk-detail" data-label="الخدمة">${esc(b.serviceName)}</td>
      <td class="bk-detail" data-label="الفرع">${esc(b.branchName)}</td>
      <td class="bk-detail" data-label="الموعد">${esc(dShort.format(new Date(b.date)))}، ${t12(b.time)}</td>
      <td class="bk-detail" data-label="الجوال" dir="ltr">${esc(b.phone)}</td>
      <td class="bk-detail" data-label="الدفع">${esc({ tabby: "تابي", bank: "تحويل بنكي", cash: "كاش", tamara: "تمارا", card: "بطاقة" }[b.pay] || b.pay)}</td>
      <td class="bk-detail" data-label="الحالة" style="text-align:start"><span class="badge ${b.status}">${statusLabel(b.status)}</span>${b.paid ? '<br><span class="badge confirmed" style="margin-top:4px">💳 مدفوع</span>' : ""}${b.rescheduleRequested ? '<br><span class="badge pending" style="margin-top:4px">⏰ طلبت تأجيل</span>' : ""}</td>
      <td class="bk-detail notes-cell" data-label="ملاحظات" style="text-align:start">${b.health && b.health.length ? `<span class="health-flags">⚠️ ${esc(b.health.map(i => HEALTH_LABELS[i] || i).join("، "))}</span><br>` : ""}${esc(b.notes || "")}${retouchInfo}</td>
      <td class="bk-detail" data-label=""><div class="row-actions">${actions.join("")}</div></td>
    </tr>`;
  }).join("");
  body.querySelectorAll("tr[data-id]").forEach(tr => {
    tr.querySelector("[data-toggle]").addEventListener("click", () => {
      const wasOpen = tr.classList.contains("expanded");
      body.querySelectorAll("tr.expanded").forEach(x => x.classList.remove("expanded"));
      if (!wasOpen) tr.classList.add("expanded");
    });
  });
  body.querySelectorAll("[data-act]").forEach(btn => btn.addEventListener("click", async () => {
    try {
      await api(`/admin/bookings/${btn.dataset.id}`, { method: "PATCH", body: JSON.stringify({ status: btn.dataset.act }) });
      toast("تم تحديث حالة الحجز");
      loadBookings();
    } catch (e) { toast(e.message); }
  }));
  body.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async () => {
    if (!confirm("هل أنتِ متأكدة من حذف هذا الحجز نهائياً؟ ما يمديك تتراجعين عن هذا القرار.")) return;
    try {
      await api(`/admin/bookings/${btn.dataset.del}`, { method: "DELETE" });
      toast("تم حذف الحجز نهائياً");
      loadBookings();
    } catch (e) { toast(e.message); }
  }));
  body.querySelectorAll("[data-retouch]").forEach(btn => btn.addEventListener("click", () => {
    openRetouchModal(bookingsCache.find(x => x.id === btn.dataset.retouch));
  }));
}
["f-status", "f-branch"].forEach(id => document.getElementById(id).addEventListener("change", loadBookings));
document.getElementById("f-q").addEventListener("input", debounce(loadBookings, 300));
document.getElementById("refresh-bookings").addEventListener("click", loadBookings);
function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

// ---------- add a retouch session for a past booking (admin override) ----------
function openRetouchModal(orig) {
  openModal("حجز جلسة رتوش", `
    <p class="hint">رتوش لـ <b>${esc(orig.name)}</b> — ${esc(orig.serviceName)} بتاريخ ${esc(orig.date)} في فرع ${esc(orig.branchName)}. الجلسة مجانية ولا تخضع لقيود فترة الأحقية عند إضافتها من هنا.</p>
    <div class="row" style="margin-top:12px">
      <div><label for="rt-date">التاريخ</label><input type="date" id="rt-date"></div>
      <div><label for="rt-time">الوقت</label><input type="time" id="rt-time"></div>
    </div>
    <button class="btn" id="rt-submit" style="width:100%;margin-top:14px">تأكيد حجز الرتوش</button>
    <div class="login-err" id="rt-err"></div>
  `);
  document.getElementById("rt-submit").onclick = async () => {
    const err = document.getElementById("rt-err");
    err.classList.remove("show");
    const date = document.getElementById("rt-date").value, time = document.getElementById("rt-time").value;
    if (!date || !time) { err.textContent = "حددي التاريخ والوقت"; err.classList.add("show"); return; }
    try {
      await api("/admin/bookings", { method: "POST", body: JSON.stringify({
        serviceId: "retouch", retouchForBookingId: orig.id, branch: orig.branch,
        name: orig.name, phone: orig.phone, date, time, status: "confirmed", pay: "cash"
      }) });
      toast("تم حجز جلسة الرتوش");
      closeModal(); loadBookings();
    } catch (e) { err.textContent = e.message; err.classList.add("show"); }
  };
}

// ---------- manual booking (customer messaged on WhatsApp) ----------
document.getElementById("new-booking-btn").addEventListener("click", () => {
  const svcOptions = SERVICES_ALL.filter(s => !s.hidden).map(s => `<option value="${s.id}">${esc(s.name)} — ${s.price} ريال</option>`).join("");
  const branchOptions = BRANCHES.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
  openModal("حجز جديد (من الواتساب)", `
    <div class="field"><label for="nb-service">الخدمة</label><select id="nb-service">${svcOptions}</select></div>
    <div class="field"><label for="nb-branch">الفرع</label><select id="nb-branch">${branchOptions}</select></div>
    <div class="row" style="margin-top:12px">
      <div><label for="nb-date">التاريخ</label><input type="date" id="nb-date"></div>
      <div><label for="nb-time">الوقت</label><input type="time" id="nb-time"></div>
    </div>
    <div class="row" style="margin-top:12px">
      <div><label for="nb-name1">الاسم الأول</label><input id="nb-name1"></div>
      <div><label for="nb-name2">اسم الأب</label><input id="nb-name2"></div>
      <div><label for="nb-name3">اسم العائلة</label><input id="nb-name3"></div>
    </div>
    <div class="field" style="margin-top:12px"><label for="nb-phone">رقم الجوال</label><input id="nb-phone" dir="ltr" placeholder="05xxxxxxxx"></div>
    <div class="row" style="margin-top:12px">
      <div><label for="nb-pay">طريقة الدفع</label><select id="nb-pay"><option value="cash">كاش</option><option value="bank">تحويل بنكي</option></select></div>
      <div><label for="nb-status">الحالة</label><select id="nb-status"><option value="confirmed">مؤكد</option><option value="pending">قيد الانتظار</option><option value="done">مكتمل</option></select></div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin-top:12px"><input type="checkbox" id="nb-paid" style="width:auto">تم الدفع فعلاً</label>
    <div class="field" style="margin-top:12px"><label for="nb-notes">ملاحظات (اختياري)</label><textarea id="nb-notes" rows="2"></textarea></div>
    <button class="btn" id="nb-submit" style="width:100%;margin-top:14px">إضافة الحجز</button>
    <div class="login-err" id="nb-err"></div>
  `);
  document.getElementById("nb-submit").onclick = async () => {
    const err = document.getElementById("nb-err");
    err.classList.remove("show");
    const nm1 = document.getElementById("nb-name1").value.trim();
    const nm2 = document.getElementById("nb-name2").value.trim();
    const nm3 = document.getElementById("nb-name3").value.trim();
    if (!nm1 || !nm2 || !nm3) { err.textContent = "الاسم الثلاثي مطلوب (الاسم الأول، اسم الأب، اسم العائلة)"; err.classList.add("show"); return; }
    const payload = {
      serviceId: document.getElementById("nb-service").value,
      branch: document.getElementById("nb-branch").value,
      date: document.getElementById("nb-date").value,
      time: document.getElementById("nb-time").value,
      name: `${nm1} ${nm2} ${nm3}`,
      phone: document.getElementById("nb-phone").value,
      pay: document.getElementById("nb-pay").value,
      status: document.getElementById("nb-status").value,
      paid: document.getElementById("nb-paid").checked,
      notes: document.getElementById("nb-notes").value
    };
    try {
      await api("/admin/bookings", { method: "POST", body: JSON.stringify(payload) });
      toast("تم إضافة الحجز");
      closeModal(); loadBookings();
    } catch (e) { err.textContent = e.message; err.classList.add("show"); }
  };
});

// ---------- schedule ----------
async function loadSchedule() {
  scheduleState = await api("/admin/schedule");
  renderSchedule();
}
function renderSchedule() {
  if (!scheduleState || !currentBranch) return;
  const sched = scheduleState.schedule[currentBranch] || { ranges: {}, capacity: 1 };
  document.getElementById("week-ranges").innerHTML = WD_ORDER.map(n => {
    const r = sched.ranges && sched.ranges[n];
    return `<div class="wr-row ${r ? "" : "off"}" data-wd="${n}">
      <label class="wr-day"><input type="checkbox" data-wd-on="${n}" ${r ? "checked" : ""}>${WD_NAMES[n]}</label>
      <div class="wr-times">
        <input type="time" data-wd-from="${n}" value="${r ? r.from : "14:00"}">
        <span class="hint">إلى</span>
        <input type="time" data-wd-to="${n}" value="${r ? r.to : "20:00"}">
      </div>
    </div>`;
  }).join("");
  document.getElementById("capacity").value = sched.capacity || 1;

  document.querySelectorAll("[data-wd-on]").forEach(cb => cb.addEventListener("change", () => {
    cb.closest(".wr-row").classList.toggle("off", !cb.checked);
  }));
  document.getElementById("schedule-saved").style.display = "none";

  renderOverrides();
}
document.getElementById("save-schedule").addEventListener("click", async () => {
  const ranges = {};
  let bad = false;
  document.querySelectorAll(".wr-row").forEach(row => {
    const wd = row.dataset.wd;
    if (!row.querySelector(`[data-wd-on="${wd}"]`).checked) return;
    const from = row.querySelector(`[data-wd-from="${wd}"]`).value;
    const to = row.querySelector(`[data-wd-to="${wd}"]`).value;
    if (!from || !to || from >= to) { bad = true; return; }
    ranges[wd] = { from, to };
  });
  if (bad) return toast("تأكدي أن وقت البداية قبل وقت النهاية في كل يوم مفعّل");
  const capacity = Number(document.getElementById("capacity").value) || 1;
  try {
    await api("/admin/schedule", { method: "PUT", body: JSON.stringify({ branch: currentBranch, ranges, capacity }) });
    document.getElementById("schedule-saved").style.display = "inline";
    toast("تم حفظ الجدول");
  } catch (e) { toast(e.message); }
});

// ---------- date-specific calendar ----------
const ovDLong = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { weekday: "long", day: "numeric", month: "long" });
const ovMName = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { month: "long", year: "numeric" });
const ovKey = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const ovToday = new Date(); ovToday.setHours(0, 0, 0, 0);
let ovMonth = new Date(ovToday.getFullYear(), ovToday.getMonth(), 1);
let ovSelected = null; // date key string
let ovEditRange = { from: "14:00", to: "20:00" };

function renderOverrides() { renderOvCalendar(); }

function renderOvCalendar() {
  const y = ovMonth.getFullYear(), mo = ovMonth.getMonth();
  document.getElementById("ov-cal-label").textContent = ovMName.format(ovMonth);
  const sched = (scheduleState.schedule[currentBranch]) || { weekdays: [], slots: [] };
  const overrides = scheduleState.overrides[currentBranch] || {};
  const first = new Date(y, mo, 1), days = new Date(y, mo + 1, 0).getDate();
  const lead = (first.getDay() + 1) % 7;
  const dows = ["س", "ح", "ن", "ث", "ر", "خ", "ج"];
  let cells = dows.map(d => `<div class="dow">${d}</div>`).join("") + "<div></div>".repeat(lead);
  for (let d = 1; d <= days; d++) {
    const dt = new Date(y, mo, d), key = ovKey(dt), isPast = dt < ovToday;
    const ov = overrides[key];
    const stClass = ov ? (ov.closed ? "st-closed" : "st-custom") : "";
    const sel = ovSelected === key ? "sel" : "";
    cells += `<button class="ov-day ${stClass} ${sel} ${isPast ? "past" : ""}" ${isPast ? "disabled" : `data-ovd="${key}"`}>${d}<span class="dot"></span></button>`;
  }
  document.getElementById("ov-cal").innerHTML = cells;
  document.querySelectorAll("#ov-cal [data-ovd]").forEach(btn => btn.addEventListener("click", () => {
    ovSelected = btn.dataset.ovd; renderOvCalendar(); renderOvEditor();
  }));
  if (ovSelected) renderOvEditor(); else document.getElementById("ov-editor").style.display = "none";
}
document.getElementById("ov-pm").addEventListener("click", () => { ovMonth = new Date(ovMonth.getFullYear(), ovMonth.getMonth() - 1, 1); renderOvCalendar(); });
document.getElementById("ov-nm").addEventListener("click", () => { ovMonth = new Date(ovMonth.getFullYear(), ovMonth.getMonth() + 1, 1); renderOvCalendar(); });

function renderOvEditor() {
  const el = document.getElementById("ov-editor");
  el.style.display = "block";
  const [y, m, d] = ovSelected.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const sched = scheduleState.schedule[currentBranch] || { ranges: {} };
  const ov = (scheduleState.overrides[currentBranch] || {})[ovSelected];
  const defaultRange = sched.ranges && sched.ranges[dt.getDay()];

  if (!ov) {
    ovEditRange = defaultRange ? { ...defaultRange } : { from: "14:00", to: "20:00" };
    el.innerHTML = `<h4>${ovDLong.format(dt)}</h4>
      <p class="hint" style="margin-bottom:14px">يتبع الجدول الافتراضي حالياً: ${defaultRange ? `من ${t12(defaultRange.from)} إلى ${t12(defaultRange.to)}` : "مغلق (ليس ضمن أيام الدوام)"}</p>
      <button class="btn btn-ghost btn-sm" id="ov-mk-custom">تخصيص دوام هذا اليوم</button>
      <button class="btn btn-ghost btn-sm" id="ov-mk-closed">إغلاق هذا اليوم بالكامل</button>`;
    document.getElementById("ov-mk-custom").onclick = () => renderOvCustomForm(dt);
    document.getElementById("ov-mk-closed").onclick = async () => {
      try { await api("/admin/overrides", { method: "POST", body: JSON.stringify({ branch: currentBranch, date: ovSelected, closed: true }) }); toast("تم إغلاق اليوم"); loadSchedule(); }
      catch (e) { toast(e.message); }
    };
    return;
  }

  if (ov.closed) {
    el.innerHTML = `<h4>${ovDLong.format(dt)}</h4><p class="hint" style="margin-bottom:14px">هذا اليوم مغلق بالكامل.</p>
      <button class="btn btn-ghost btn-sm" id="ov-mk-custom2">تخصيص دوام بدل الإغلاق</button>
      <button class="btn btn-ghost btn-sm" id="ov-clear">رجّعيه للجدول الافتراضي</button>`;
    document.getElementById("ov-mk-custom2").onclick = () => { ovEditRange = defaultRange ? { ...defaultRange } : { from: "14:00", to: "20:00" }; renderOvCustomForm(dt); };
    document.getElementById("ov-clear").onclick = () => clearOverride();
    return;
  }

  ovEditRange = { ...ov.range };
  renderOvCustomForm(dt, true);
}

function renderOvCustomForm(dt, hasOverride) {
  const el = document.getElementById("ov-editor");
  el.innerHTML = `<h4>${ovDLong.format(dt)}</h4>
    <div class="row">
      <div><label for="ov-from">من</label><input type="time" id="ov-from" value="${ovEditRange.from}"></div>
      <div><label for="ov-to">إلى</label><input type="time" id="ov-to" value="${ovEditRange.to}"></div>
    </div>
    <button class="btn" id="ov-save-custom" style="margin-top:12px">حفظ دوام هذا اليوم</button>
    ${hasOverride ? '<button class="btn btn-ghost btn-sm" id="ov-clear">رجّعيه للجدول الافتراضي</button>' : ""}`;
  document.getElementById("ov-save-custom").onclick = async () => {
    const from = document.getElementById("ov-from").value, to = document.getElementById("ov-to").value;
    if (!from || !to || from >= to) return toast("تأكدي أن وقت البداية قبل وقت النهاية");
    try {
      await api("/admin/overrides", { method: "POST", body: JSON.stringify({ branch: currentBranch, date: ovSelected, closed: false, range: { from, to } }) });
      toast("تم حفظ دوام هذا اليوم");
      loadSchedule();
    } catch (e) { toast(e.message); }
  };
  if (hasOverride) document.getElementById("ov-clear").onclick = () => clearOverride();
}
async function clearOverride() {
  try {
    await api(`/admin/overrides/${currentBranch}/${ovSelected}`, { method: "DELETE" });
    toast("رجع اليوم للجدول الافتراضي");
    loadSchedule();
  } catch (e) { toast(e.message); }
}

// ---------- services ----------
async function loadServices() {
  SERVICES_ALL = await api("/admin/services");
  const services = SERVICES_ALL.filter(s => !s.hidden);
  const el = document.getElementById("services-list");
  el.innerHTML = services.map(s => `
    <div class="card" style="margin-bottom:12px;padding:16px">
      <div class="row">
        <div><label>الاسم</label><input data-f="name" data-id="${s.id}" value="${esc(s.name)}"></div>
        <div style="flex:1 1 100%"><label>الوصف</label><textarea data-f="desc" data-id="${s.id}" rows="2">${esc(s.desc || "")}</textarea></div>
        <div><label>السعر (ريال)</label><input data-f="price" data-id="${s.id}" type="number" value="${s.price}"></div>
        <div><label>مدة الجلسة (دقيقة)</label><input data-f="durationMin" data-id="${s.id}" type="number" min="5" step="5" value="${s.durationMin || 60}"></div>
        <div style="flex:0 0 auto;align-self:center;margin-top:18px">
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" data-f="active" data-id="${s.id}" ${s.active ? "checked" : ""} style="width:auto">مفعّلة</label>
        </div>
        <div style="flex:0 0 auto;align-self:center;margin-top:18px"><button class="btn btn-sm" data-save="${s.id}">حفظ</button></div>
      </div>
    </div>`).join("");
  el.querySelectorAll("[data-save]").forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.save;
    const name = el.querySelector(`[data-f=name][data-id="${id}"]`).value;
    const desc = el.querySelector(`[data-f=desc][data-id="${id}"]`).value;
    const price = el.querySelector(`[data-f=price][data-id="${id}"]`).value;
    const durationMin = el.querySelector(`[data-f=durationMin][data-id="${id}"]`).value;
    const active = el.querySelector(`[data-f=active][data-id="${id}"]`).checked;
    try {
      await api(`/admin/services/${id}`, { method: "PUT", body: JSON.stringify({ name, desc, price, durationMin, active }) });
      toast("تم الحفظ");
    } catch (e) { toast(e.message); }
  }));
}

// ---------- discount codes ----------
const GATEWAY_LABEL = { all: "الكل", tabby: "تابي", bank: "تحويل بنكي", cash: "كاش", card: "مدى/Apple Pay/بطاقة", tamara: "تمارا" };
let dSelectedServices = new Set(["all"]);

function renderDServiceChips() {
  const el = document.getElementById("d-services");
  const options = [{ id: "all", name: "كل الخدمات" }].concat(SERVICES_ALL.filter(s => !s.hidden));
  el.innerHTML = options.map(s =>
    `<button type="button" class="chip-select ${dSelectedServices.has(s.id) ? "on" : ""}" data-sid="${s.id}">${esc(s.name)}</button>`).join("");
  el.querySelectorAll("[data-sid]").forEach(btn => btn.addEventListener("click", () => {
    const id = btn.dataset.sid;
    if (id === "all") { dSelectedServices = new Set(["all"]); }
    else {
      dSelectedServices.delete("all");
      if (dSelectedServices.has(id)) dSelectedServices.delete(id); else dSelectedServices.add(id);
      if (!dSelectedServices.size) dSelectedServices.add("all");
    }
    renderDServiceChips();
  }));
}

async function loadDiscounts() {
  if (!SERVICES_ALL.length) SERVICES_ALL = await api("/admin/services");
  renderDServiceChips();
  const list = await api("/admin/discounts");
  const body = document.getElementById("discounts-body");
  const empty = document.getElementById("discounts-empty");
  if (!list.length) { body.innerHTML = ""; empty.style.display = "block"; return; }
  empty.style.display = "none";
  body.innerHTML = list.map(d => {
    const svcLabel = d.serviceIds.includes("all") ? "كل الخدمات" : d.serviceIds.map(id => {
      const s = SERVICES_ALL.find(x => x.id === id); return s ? s.name : id;
    }).join("، ");
    const dur = (d.startDate || "...") + " → " + (d.endDate || "بلا نهاية");
    return `<tr>
      <td data-label="" class="latin" dir="ltr" style="font-weight:600;font-size:15px">${esc(d.code)}</td>
      <td data-label="النسبة">${d.percent}%</td>
      <td data-label="بوابة الدفع">${esc(GATEWAY_LABEL[d.gateway] || d.gateway)}</td>
      <td data-label="يسري على" style="text-align:start">${esc(svcLabel)}</td>
      <td data-label="المدة" style="text-align:start">${esc(dur)}</td>
      <td data-label="الحالة"><span class="disc-badge ${d.active ? "active" : "inactive"}">${d.active ? "مفعّل" : "متوقف"}</span></td>
      <td data-label=""><div class="row-actions">
        <button class="btn btn-ghost btn-sm" data-toggle-d="${d.id}" data-active="${d.active}">${d.active ? "إيقاف" : "تفعيل"}</button>
        <button class="btn btn-ghost btn-sm" data-del-d="${d.id}">حذف</button>
      </div></td>
    </tr>`;
  }).join("");
  body.querySelectorAll("[data-toggle-d]").forEach(btn => btn.addEventListener("click", async () => {
    const d = list.find(x => x.id === btn.dataset.toggleD);
    try {
      await api(`/admin/discounts/${d.id}`, { method: "PUT", body: JSON.stringify(Object.assign({}, d, { active: !d.active })) });
      toast("تم التحديث"); loadDiscounts();
    } catch (e) { toast(e.message); }
  }));
  body.querySelectorAll("[data-del-d]").forEach(btn => btn.addEventListener("click", async () => {
    await api(`/admin/discounts/${btn.dataset.delD}`, { method: "DELETE" });
    toast("تم حذف الكود"); loadDiscounts();
  }));
}

document.getElementById("d-create").addEventListener("click", async () => {
  const err = document.getElementById("d-err");
  err.classList.remove("show");
  const payload = {
    code: document.getElementById("d-code").value,
    percent: document.getElementById("d-percent").value,
    gateway: document.getElementById("d-gateway").value,
    serviceIds: [...dSelectedServices],
    startDate: document.getElementById("d-start").value || null,
    endDate: document.getElementById("d-end").value || null,
    active: true
  };
  try {
    await api("/admin/discounts", { method: "POST", body: JSON.stringify(payload) });
    document.getElementById("d-code").value = "";
    toast("تم إنشاء الكود");
    loadDiscounts();
  } catch (e) { err.textContent = e.message; err.classList.add("show"); }
});

// ---------- offers (scrolling banner) ----------
async function loadOffers() {
  const list = await api("/admin/offers");
  const el = document.getElementById("offers-list");
  const empty = document.getElementById("offers-empty");
  if (!list.length) { el.innerHTML = ""; empty.style.display = "block"; return; }
  empty.style.display = "none";
  el.innerHTML = list.map(o => {
    const dur = (o.startDate || "بدون بداية محددة") + " → " + (o.endDate || "بلا نهاية");
    return `<div class="card" style="margin-bottom:10px;padding:14px">
      <p style="margin:0 0 8px">${esc(o.text)}</p>
      <p class="hint" style="margin:0 0 10px">${esc(dur)}</p>
      <span class="disc-badge ${o.active ? "active" : "inactive"}" style="margin-bottom:10px;display:inline-flex">${o.active ? "مفعّل" : "متوقف"}</span>
      <div class="row-actions" style="margin-top:8px">
        <button class="btn btn-ghost btn-sm" data-toggle-o="${o.id}" data-active="${o.active}">${o.active ? "إيقاف" : "تفعيل"}</button>
        <button class="btn btn-ghost btn-sm" data-del-o="${o.id}">حذف</button>
      </div>
    </div>`;
  }).join("");
  el.querySelectorAll("[data-toggle-o]").forEach(btn => btn.addEventListener("click", async () => {
    const o = list.find(x => x.id === btn.dataset.toggleO);
    try {
      await api(`/admin/offers/${o.id}`, { method: "PUT", body: JSON.stringify(Object.assign({}, o, { active: !o.active })) });
      toast("تم التحديث"); loadOffers();
    } catch (e) { toast(e.message); }
  }));
  el.querySelectorAll("[data-del-o]").forEach(btn => btn.addEventListener("click", async () => {
    if (!confirm("حذف هذا العرض؟")) return;
    await api(`/admin/offers/${btn.dataset.delO}`, { method: "DELETE" });
    toast("تم حذف العرض"); loadOffers();
  }));
}
document.getElementById("o-create").addEventListener("click", async () => {
  const err = document.getElementById("o-err");
  err.classList.remove("show");
  const payload = {
    text: document.getElementById("o-text").value,
    startDate: document.getElementById("o-start").value || null,
    endDate: document.getElementById("o-end").value || null,
    active: true
  };
  try {
    await api("/admin/offers", { method: "POST", body: JSON.stringify(payload) });
    document.getElementById("o-text").value = "";
    toast("تم نشر العرض");
    loadOffers();
  } catch (e) { err.textContent = e.message; err.classList.add("show"); }
});

// ---------- account ----------
document.getElementById("change-pw-btn").addEventListener("click", async () => {
  const err = document.getElementById("pw-err");
  err.classList.remove("show");
  const currentPassword = document.getElementById("cur-pw").value;
  const newPassword = document.getElementById("new-pw").value;
  try {
    await api("/admin/password", { method: "PUT", body: JSON.stringify({ currentPassword, newPassword }) });
    document.getElementById("cur-pw").value = ""; document.getElementById("new-pw").value = "";
    toast("تم تغيير كلمة المرور");
  } catch (e) {
    err.textContent = e.message; err.classList.add("show");
  }
});

checkSession();
