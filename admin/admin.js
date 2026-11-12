const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtN = n => Number(n).toLocaleString("en-US");
const dShort = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { day: "numeric", month: "short" });
const t12 = s => { let [h, m] = s.split(":").map(Number); const p = h >= 12 ? "م" : "ص"; h = h % 12 || 12; return h + ":" + String(m).padStart(2, "0") + " " + p; };
const WD_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
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
let scheduleState = null; // {schedule, overrides, branches}
let currentBranch = null;

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
    document.querySelectorAll("#schedule-branch-tabs [data-branch]").forEach(b => b.classList.toggle("btn-ghost", b !== btn));
    renderSchedule();
  }));

  loadBookings();
  loadSchedule();
  loadServices();
  loadDiscounts();
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
    return `<tr>
      <td><span class="latin" dir="ltr">${esc(b.ref)}</span></td>
      <td>${esc(b.serviceName)}</td>
      <td>${esc(b.branchName)}</td>
      <td>${esc(dShort.format(new Date(b.date)))}، ${t12(b.time)}</td>
      <td>${esc(b.name)}</td>
      <td dir="ltr">${esc(b.phone)}</td>
      <td>${esc({ tabby: "تابي", tamara: "تمارا", card: "بطاقة" }[b.pay] || b.pay)}</td>
      <td><span class="badge ${b.status}">${statusLabel(b.status)}</span></td>
      <td class="notes-cell">${b.health && b.health.length ? '<span class="health-flags" title="لديها ملاحظات صحية">⚠️ ملاحظات صحية</span><br>' : ""}${esc(b.notes || "")}</td>
      <td><div class="row-actions">${actions.join("")}</div></td>
    </tr>`;
  }).join("");
  body.querySelectorAll("[data-act]").forEach(btn => btn.addEventListener("click", async () => {
    try {
      await api(`/admin/bookings/${btn.dataset.id}`, { method: "PATCH", body: JSON.stringify({ status: btn.dataset.act }) });
      toast("تم تحديث حالة الحجز");
      loadBookings();
    } catch (e) { toast(e.message); }
  }));
}
["f-status", "f-branch"].forEach(id => document.getElementById(id).addEventListener("change", loadBookings));
document.getElementById("f-q").addEventListener("input", debounce(loadBookings, 300));
document.getElementById("refresh-bookings").addEventListener("click", loadBookings);
function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }

// ---------- schedule ----------
async function loadSchedule() {
  scheduleState = await api("/admin/schedule");
  renderSchedule();
}
function renderSchedule() {
  if (!scheduleState || !currentBranch) return;
  const sched = scheduleState.schedule[currentBranch] || { weekdays: [], slots: [], capacity: 1 };
  document.getElementById("weekdays").innerHTML = WD_ORDER.map(n =>
    `<button class="wd ${sched.weekdays.includes(n) ? "on" : ""}" data-wd="${n}">${WD_NAMES[n]}</button>`).join("");
  document.getElementById("slot-chips").innerHTML = sched.slots.map(t =>
    `<span class="chip">${t12(t)}<button data-rm="${t}" aria-label="حذف">×</button></span>`).join("") || '<span class="hint">لا توجد أوقات مضافة</span>';
  document.getElementById("capacity").value = sched.capacity || 1;

  document.querySelectorAll("#weekdays .wd").forEach(btn => btn.addEventListener("click", () => btn.classList.toggle("on")));
  document.querySelectorAll("#slot-chips [data-rm]").forEach(btn => btn.addEventListener("click", () => {
    sched.slots = sched.slots.filter(t => t !== btn.dataset.rm);
    renderSchedule();
  }));
  document.getElementById("schedule-saved").style.display = "none";

  renderOverrides();
}
document.getElementById("add-slot-btn").addEventListener("click", () => {
  const input = document.getElementById("new-slot-time");
  if (!input.value) return;
  const sched = scheduleState.schedule[currentBranch] || (scheduleState.schedule[currentBranch] = { weekdays: [], slots: [], capacity: 1 });
  if (!sched.slots.includes(input.value)) { sched.slots.push(input.value); sched.slots.sort(); }
  input.value = "";
  renderSchedule();
});
document.getElementById("save-schedule").addEventListener("click", async () => {
  const weekdays = [...document.querySelectorAll("#weekdays .wd.on")].map(b => Number(b.dataset.wd));
  const slots = (scheduleState.schedule[currentBranch] || { slots: [] }).slots;
  const capacity = Number(document.getElementById("capacity").value) || 1;
  try {
    await api("/admin/schedule", { method: "PUT", body: JSON.stringify({ branch: currentBranch, weekdays, slots, capacity }) });
    document.getElementById("schedule-saved").style.display = "inline";
    toast("تم حفظ الجدول");
  } catch (e) { toast(e.message); }
});

// overrides
let ovSlots = [];
document.getElementById("ov-mode").addEventListener("change", e => {
  document.getElementById("ov-custom-wrap").style.display = e.target.value === "custom" ? "block" : "none";
});
document.getElementById("ov-add-slot-btn").addEventListener("click", () => {
  const input = document.getElementById("ov-new-slot");
  if (!input.value || ovSlots.includes(input.value)) return;
  ovSlots.push(input.value); ovSlots.sort(); input.value = ""; renderOvSlots();
});
function renderOvSlots() {
  document.getElementById("ov-slot-chips").innerHTML = ovSlots.map(t =>
    `<span class="chip">${t12(t)}<button data-ovrm="${t}">×</button></span>`).join("") || '<span class="hint">أضيفي وقت واحد على الأقل</span>';
  document.querySelectorAll("[data-ovrm]").forEach(btn => btn.addEventListener("click", () => {
    ovSlots = ovSlots.filter(t => t !== btn.dataset.ovrm); renderOvSlots();
  }));
}
document.getElementById("add-override").addEventListener("click", async () => {
  const date = document.getElementById("ov-date").value;
  if (!date) return toast("اختاري تاريخ");
  const closed = document.getElementById("ov-mode").value === "closed";
  if (!closed && !ovSlots.length) return toast("أضيفي أوقات أو اختاري إغلاق اليوم");
  try {
    await api("/admin/overrides", { method: "POST", body: JSON.stringify({ branch: currentBranch, date, closed, slots: ovSlots }) });
    ovSlots = []; renderOvSlots();
    document.getElementById("ov-date").value = "";
    toast("تم إضافة الاستثناء");
    loadSchedule();
  } catch (e) { toast(e.message); }
});
function renderOverrides() {
  const list = (scheduleState.overrides[currentBranch]) || {};
  const dates = Object.keys(list).sort();
  const el = document.getElementById("override-list");
  if (!dates.length) { el.innerHTML = '<p class="hint">لا توجد استثناءات مضافة لهذا الفرع</p>'; return; }
  el.innerHTML = dates.map(d => {
    const o = list[d];
    const desc = o.closed ? "مغلق بالكامل" : "أوقات: " + o.slots.map(t12).join("، ");
    return `<div class="override-item"><div class="ov-info"><b>${esc(d)}</b> — ${esc(desc)}</div><button class="btn btn-ghost btn-sm" data-del-ov="${d}">حذف</button></div>`;
  }).join("");
  el.querySelectorAll("[data-del-ov]").forEach(btn => btn.addEventListener("click", async () => {
    await api(`/admin/overrides/${currentBranch}/${btn.dataset.delOv}`, { method: "DELETE" });
    toast("تم حذف الاستثناء");
    loadSchedule();
  }));
}

// ---------- services ----------
async function loadServices() {
  const services = await api("/admin/services");
  const el = document.getElementById("services-list");
  el.innerHTML = services.map(s => `
    <div class="card" style="margin-bottom:12px;padding:16px">
      <div class="row">
        <div><label>الاسم</label><input data-f="name" data-id="${s.id}" value="${esc(s.name)}"></div>
        <div><label>السعر (ريال)</label><input data-f="price" data-id="${s.id}" type="number" value="${s.price}"></div>
        <div style="flex:0 0 auto;align-self:center;margin-top:18px">
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" data-f="active" data-id="${s.id}" ${s.active ? "checked" : ""} style="width:auto">مفعّلة</label>
        </div>
        <div style="flex:0 0 auto;align-self:center;margin-top:18px"><button class="btn btn-sm" data-save="${s.id}">حفظ</button></div>
      </div>
    </div>`).join("");
  el.querySelectorAll("[data-save]").forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.save;
    const name = el.querySelector(`[data-f=name][data-id="${id}"]`).value;
    const price = el.querySelector(`[data-f=price][data-id="${id}"]`).value;
    const active = el.querySelector(`[data-f=active][data-id="${id}"]`).checked;
    try {
      await api(`/admin/services/${id}`, { method: "PUT", body: JSON.stringify({ name, price, active }) });
      toast("تم الحفظ");
    } catch (e) { toast(e.message); }
  }));
}

// ---------- discount codes ----------
const GATEWAY_LABEL = { all: "الكل", card: "مدى/Apple Pay/بطاقة", tabby: "تابي", tamara: "تمارا" };
let SERVICES_ALL = [];
let dSelectedServices = new Set(["all"]);

function renderDServiceChips() {
  const el = document.getElementById("d-services");
  const options = [{ id: "all", name: "كل الخدمات" }].concat(SERVICES_ALL);
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
      <td class="latin" dir="ltr">${esc(d.code)}</td>
      <td>${d.percent}%</td>
      <td>${esc(GATEWAY_LABEL[d.gateway] || d.gateway)}</td>
      <td>${esc(svcLabel)}</td>
      <td>${esc(dur)}</td>
      <td><span class="disc-badge ${d.active ? "active" : "inactive"}">${d.active ? "مفعّل" : "متوقف"}</span></td>
      <td><div class="row-actions">
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
