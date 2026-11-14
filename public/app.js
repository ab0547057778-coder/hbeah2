const WA = "966544936188";
const fmtN = n => n.toLocaleString("en-US");
const dLong = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn",{weekday:"long",day:"numeric",month:"long"});
const mName = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn",{month:"long",year:"numeric"});
const key = d => d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const t12 = s => {let [h,m]=s.split(":").map(Number);const p=h>=12?"م":"ص";h=h%12||12;return h+":"+String(m).padStart(2,"0")+" "+p};
const today = new Date(); today.setHours(0,0,0,0);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const val=id=>document.getElementById(id).value;

async function api(path, opts){
  const res = await fetch("/api"+path, Object.assign({headers:{"Content-Type":"application/json"}}, opts));
  let data = null; try{ data = await res.json(); }catch(e){}
  if(!res.ok) throw new Error((data&&data.error)||"حصل خطأ، حاولي مرة أخرى");
  return data;
}

let SERVICES=[], BRANCHES=[], CURRENT_CUSTOMER=null;
let PAYMENT_CONFIG={card:false,tabby:false,tamara:false};
const availCache = new Map(); // "branch:year-month" -> {date:[{time,available}]}

api("/payment-config").then(c=>{ PAYMENT_CONFIG=c; }).catch(()=>{});
function isPayLive(method){ return !!PAYMENT_CONFIG[method]; }

// If we just came back from a hosted payment page, show the real
// server-confirmed result instead of trusting the URL alone.
(function checkPaymentReturn(){
  const params = new URLSearchParams(location.search);
  const ref = params.get("paid_ref");
  if(!ref) return;
  history.replaceState(null, "", location.pathname);
  const banner = document.createElement("div");
  banner.className = "pay-return-banner";
  banner.innerHTML = '<div class="wrap"><p class="hint">نتحقق من حالة الدفع...</p></div>';
  document.body.prepend(banner);
  api(`/bookings/ref/${encodeURIComponent(ref)}`).then(b=>{
    const ok = b.paid;
    banner.innerHTML = `<div class="wrap pay-return-${ok?"ok":"bad"}">
      <b>${ok?"تم الدفع بنجاح ✓":"لم نتمكن من تأكيد الدفع"}</b>
      <p>${esc(b.serviceName)} — ${esc(b.branchName)} — رقم الحجز <span dir="ltr">${esc(b.ref)}</span></p>
      ${ok?"":'<p>إذا تم الخصم من حسابك، راسلينا على الواتساب برقم الحجز وبنتأكد يدوياً.</p>'}
      <button class="btn btn-ghost btn-sm" id="pay-return-close">إغلاق</button>
    </div>`;
    document.getElementById("pay-return-close").onclick=()=>banner.remove();
  }).catch(()=>{ banner.remove(); });
})();

async function loadCatalog(){
  try{
    [SERVICES, BRANCHES] = await Promise.all([api("/services"), api("/branches")]);
  }catch(e){ SERVICES=[]; BRANCHES=[]; }
  renderMenu(); renderBranches();
}
function renderMenu(){
  const menu=document.getElementById("menu");
  if(!menu) return;
  if(!SERVICES.length){ menu.innerHTML = '<p class="hint">تعذر تحميل الخدمات حالياً، حاولي تحديث الصفحة.</p>'; return; }
  menu.innerHTML=SERVICES.map(s=>`<div class="item"><div><h3>${esc(s.name)}<span class="latin">${esc(s.en)}</span></h3><p>${esc(s.desc)}</p></div><div class="price">${fmtN(s.price)}<small>ريال</small></div><button class="btn btn-rose" data-book data-service="${s.id}">احجزي</button></div>`).join("");
}
const browPh=`<svg viewBox="0 0 120 40"><path d="M6 32 C30 10, 70 4, 112 14" stroke-width="2"/><path d="M20 26 C34 14, 60 9, 96 12" stroke-width="1" opacity=".5"/></svg>`;
(function(){ const gal=document.getElementById("gal"); if(gal) gal.innerHTML=["قبل","بعد","قبل","بعد"].map(l=>`<div class="ph"><div>${browPh}${l}<br><small>صورة العميلة</small></div></div>`).join(""); })();

async function monthAvail(branch, year, month){
  const k = branch+":"+year+"-"+month;
  if(!availCache.has(k)){
    try{ availCache.set(k, await api(`/availability?branch=${branch}&year=${year}&month=${month}`)); }
    catch(e){ availCache.set(k, {}); }
  }
  return availCache.get(k);
}
async function nextOpenDate(branch){
  for(let i=0;i<3;i++){
    const d=new Date(today.getFullYear(), today.getMonth()+i, 1);
    const map = await monthAvail(branch, d.getFullYear(), d.getMonth()+1);
    const keys = Object.keys(map).filter(kk => map[kk].some(s=>s.available)).sort();
    if(keys.length){ const [y,m,dd]=keys[0].split("-").map(Number); return new Date(y,m-1,dd); }
  }
  return null;
}
async function renderBranches(){
  const grid=document.getElementById("branches-grid");
  if(!grid || !BRANCHES.length) return;
  grid.innerHTML=BRANCHES.map(b=>`<div class="branch"><h3>${esc(b.name)}</h3><p data-next="${b.id}">نجهّز أقرب موعد متاح...</p><button class="btn btn-ghost" data-book data-branch="${b.id}">احجزي في ${esc(b.name)}</button></div>`).join("");
  BRANCHES.forEach(async b=>{
    const d = await nextOpenDate(b.id);
    const el = grid.querySelector(`[data-next="${b.id}"]`);
    if(el) el.textContent = d ? "أقرب موعد متاح: "+dLong.format(d) : "لا توجد مواعيد متاحة حالياً";
  });
}
loadCatalog();

/* booking */
const sheet=document.getElementById("sheet"), body=document.getElementById("pbody"), foot=document.getElementById("pfoot");
const STEPS=["الخدمة","الفرع","الموعد","بياناتك","الدفع"];
let S, lastFocus;
function reset(){S={step:0,service:null,branch:null,date:null,time:null,name:CURRENT_CUSTOMER?CURRENT_CUSTOMER.name:"",phone:CURRENT_CUSTOMER?CURRENT_CUSTOMER.phone:"",notes:"",health:[],agree:false,pay:null,discount:null,month:new Date(today.getFullYear(),today.getMonth(),1),ref:null,submitting:false,error:""};}
function open(o={}){reset(); if(o.service) S.service=o.service; if(o.branch) S.branch=o.branch; S.step=S.service?(S.branch?2:1):0;
  lastFocus=document.activeElement; sheet.classList.add("open"); sheet.setAttribute("aria-hidden","false"); document.body.style.overflow="hidden"; render(); sheet.querySelector(".x").focus();}
function close(){sheet.classList.remove("open"); sheet.setAttribute("aria-hidden","true"); document.body.style.overflow=""; lastFocus&&lastFocus.focus();}
document.addEventListener("click",e=>{
  const b=e.target.closest("[data-book]");
  if(b){
    e.preventDefault();
    const intent={service:b.dataset.service,branch:b.dataset.branch};
    if(CURRENT_CUSTOMER) open(intent); else aOpen(intent);
  }
  if(e.target.closest("[data-close]")) close();
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&sheet.classList.contains("open")) close();});
const svc=()=>SERVICES.find(s=>s.id===S.service), br=()=>BRANCHES.find(b=>b.id===S.branch);

function render(){
  const done=S.step===5;
  document.getElementById("prog").innerHTML=STEPS.map((_,i)=>`<span class="${i<=S.step||done?"on":""}"></span>`).join("");
  document.getElementById("prog-label").textContent=done?"تم استلام طلبك":`الخطوة ${S.step+1} من ${STEPS.length}: ${STEPS[S.step]}`;
  [stepService,stepBranch,stepDate,stepDetails,stepPay,stepDone][S.step]();
  body.scrollTop=0;
}
function footer(canNext,label,onNext){
  const s=svc();
  const sum=s?`<div class="sum"><b>${esc(s.name)}</b>${[br()&&br().name,S.date&&dLong.format(S.date),S.time&&t12(S.time)].filter(Boolean).join("، ")}</div>`:`<div class="sum">اختاري خدمة للمتابعة</div>`;
  foot.innerHTML=sum+(S.step>0?`<button class="btn btn-ghost" id="back">رجوع</button>`:"")+`<button class="btn btn-rose" id="next" ${canNext?"":"disabled"}>${label}</button>`;
  const bk=document.getElementById("back"); if(bk) bk.onclick=()=>{S.step--; render();};
  document.getElementById("next").onclick=onNext;
}
const go=n=>{S.step=n;render();};

async function ensureCatalogLoaded(){
  if(!SERVICES.length || !BRANCHES.length){
    try{ [SERVICES, BRANCHES] = await Promise.all([api("/services"), api("/branches")]); }catch(e){}
  }
}
function stepService(){
  if(!SERVICES.length){ body.innerHTML='<p class="hint">نحمّل الخدمات...</p>'; footer(false,"التالي",()=>{}); ensureCatalogLoaded().then(()=>{ if(S.step===0) render(); }); return; }
  body.innerHTML=`<h3>وش الخدمة اللي تبينها؟</h3>`+SERVICES.map(s=>`<button class="opt" data-v="${s.id}" aria-pressed="${S.service===s.id}"><span class="dot"></span><span class="t"><b>${esc(s.name)}</b><small>${esc(s.en)}</small></span><span class="r">${fmtN(s.price)} ريال</span></button>`).join("");
  body.querySelectorAll(".opt").forEach(b=>b.onclick=()=>{S.service=b.dataset.v; S.step=S.branch?2:1; render();});
  footer(!!S.service,"التالي",()=>go(1));
}
function stepBranch(){
  body.innerHTML=`<h3>أي فرع يناسبك؟</h3>`+BRANCHES.map(b=>`<button class="opt" data-v="${b.id}" aria-pressed="${S.branch===b.id}"><span class="dot"></span><span class="t"><b>${esc(b.name)}</b></span></button>`).join("");
  body.querySelectorAll(".opt").forEach(b=>b.onclick=()=>{ if(S.branch!==b.dataset.v){S.date=null;S.time=null;S.month=new Date(today.getFullYear(),today.getMonth(),1);} S.branch=b.dataset.v; S.step=2; render();});
  footer(!!S.branch,"التالي",()=>go(2));
}
async function stepDate(){
  body.innerHTML=`<h3>اختاري اليوم في فرع ${esc(br().name)}</h3><p class="hint">نحمّل الأوقات المتاحة...</p>`;
  footer(false,"التالي",()=>{});
  const m=S.month, y=m.getFullYear(), mo=m.getMonth();
  const map = await monthAvail(S.branch, y, mo+1);
  if(S.step!==2) return; // user navigated away while loading
  const first=new Date(y,mo,1), days=new Date(y,mo+1,0).getDate();
  const lead=(first.getDay()+1)%7;
  const dows=["س","ح","ن","ث","ر","خ","ج"];
  let cells=dows.map(d=>`<div class="dow">${d}</div>`).join("")+"<div></div>".repeat(lead);
  for(let d=1;d<=days;d++){
    const dt=new Date(y,mo,d), k=key(dt), sl=map[k];
    const open=sl&&sl.some(x=>x.available), full=sl&&!open, sel=S.date&&key(S.date)===k;
    cells+=`<button class="day ${open?"open":""} ${full?"full":""} ${sel?"sel":""}" ${open?`data-d="${k}"`:"disabled"} aria-label="${dLong.format(dt)}${open?"":full?"، مكتمل":"، مغلق"}">${d}</button>`;
  }
  const horizon=new Date(today); horizon.setDate(horizon.getDate()+60);
  const canPrev=new Date(y,mo,1)>new Date(today.getFullYear(),today.getMonth(),1), canNext=new Date(y,mo+1,1)<=horizon;
  let times="";
  if(S.date){const sl=map[key(S.date)]||[]; times=`<h3 style="margin-top:22px">الأوقات المتاحة يوم ${dLong.format(S.date)}</h3><div class="times">${sl.map(x=>`<button class="time" data-t="${x.time}" ${x.available?"":"disabled"} aria-pressed="${S.time===x.time}">${t12(x.time)}</button>`).join("")}</div>`;}
  body.innerHTML=`<h3>اختاري اليوم في فرع ${esc(br().name)}</h3>
    <div class="cal-head"><b>${mName.format(m)}</b><div class="cal-nav"><button id="pm" aria-label="الشهر السابق" ${canPrev?"":"disabled"}>›</button><button id="nm" aria-label="الشهر التالي" ${canNext?"":"disabled"}>‹</button></div></div>
    <div class="cal">${cells}</div>
    <div class="legend"><span>الأيام الواضحة متاحة</span><span>الباهتة مغلقة أو مكتملة</span></div>${times}`;
  const pm=document.getElementById("pm"),nm=document.getElementById("nm");
  pm.onclick=()=>{S.month=new Date(y,mo-1,1);render();}; nm.onclick=()=>{S.month=new Date(y,mo+1,1);render();};
  body.querySelectorAll(".day[data-d]").forEach(b=>b.onclick=()=>{const [a,c,e]=b.dataset.d.split("-").map(Number); S.date=new Date(a,c-1,e); S.time=null; render(); const t=body.querySelector(".times"); t&&t.scrollIntoView({behavior:"smooth",block:"center"});});
  body.querySelectorAll(".time:not([disabled])").forEach(b=>b.onclick=()=>{S.time=b.dataset.t; render(); body.scrollTop=body.scrollHeight;});
  footer(!!(S.date&&S.time),"التالي",()=>go(3));
}
const HEALTH=["عندي سكري","عندي ضغط دم مرتفع أو منخفض","أستخدم أدوية سيولة الدم","عندي التهاب أو مشكلة جلدية في المنطقة","عندي حساسية من الصبغات","عندي تاتو أو مايكروبليدينق سابق للحواجب"];
const toLatin=s=>s.replace(/[٠-٩]/g,d=>"٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[^\d]/g,"");
function stepDetails(){
  const phoneLocked=!!CURRENT_CUSTOMER;
  body.innerHTML=`<h3>بياناتك</h3>
  <div class="field" id="f-name"><label for="nm-in">الاسم</label><input id="nm-in" autocomplete="name" value="${esc(S.name)}"><div class="err">اكتبي اسمك</div></div>
  <div class="field" id="f-phone"><label for="ph-in">رقم الجوال</label><input id="ph-in" inputmode="numeric" autocomplete="tel" dir="ltr" style="text-align:right" placeholder="05xxxxxxxx" value="${esc(S.phone)}" ${phoneLocked?"readonly":""}><div class="err">اكتبي رقم جوال سعودي يبدأ بـ 05 ومكوّن من 10 أرقام</div>${phoneLocked?'<p class="hint" style="margin:6px 0 0">رقم جوال حسابك المسجّل به</p>':""}</div>
  <fieldset><legend>قبل الجلسة، هل ينطبق عليك شي من هذي؟</legend><div class="checks">${HEALTH.map((h,i)=>`<label class="check"><input type="checkbox" data-h="${i}" ${S.health.includes(i)?"checked":""}>${h}</label>`).join("")}</div>
  <div class="box-note" id="hnote">بعض هذي الحالات ممكن ما يناسبها الإجراء حالياً. ننصحك تكلمينا على الواتساب قبل تأكيد موعدك. <a href="https://wa.me/${WA}" target="_blank" rel="noopener">تواصلي معنا</a></div></fieldset>
  <div class="field"><label for="nt-in">ملاحظات (اختياري)</label><textarea id="nt-in" rows="2">${esc(S.notes)}</textarea></div>
  <p class="hint" style="margin:0 0 10px">سياسة الإلغاء: الإلغاء قبل الموعد بـ ٤٨ ساعة أو أكثر يرجع لك المبلغ كامل، وبعدها نقدر نأجل موعدك مرة وحدة بدون استرجاع.</p>
  <label class="check"><input type="checkbox" id="agree" ${S.agree?"checked":""}>قرأت سياسة الإلغاء والتأجيل وأوافق عليها</label>`;
  const upd=()=>{S.name=val("nm-in").trim(); S.phone=val("ph-in"); S.notes=val("nt-in"); S.agree=document.getElementById("agree").checked;
    S.health=[...body.querySelectorAll("[data-h]:checked")].map(x=>+x.dataset.h); document.getElementById("hnote").classList.toggle("show",S.health.length>0);
    document.getElementById("next").disabled=!S.agree;};
  body.querySelectorAll("input,textarea").forEach(i=>i.addEventListener("input",upd)); body.querySelectorAll("input[type=checkbox]").forEach(i=>i.addEventListener("change",upd));
  footer(S.agree,"المتابعة للدفع",()=>{
    const okN=S.name.length>=2, ph=toLatin(S.phone), okP=/^05\d{8}$/.test(ph);
    document.getElementById("f-name").classList.toggle("bad",!okN); document.getElementById("f-phone").classList.toggle("bad",!okP);
    if(!okN) return document.getElementById("nm-in").focus(); if(!okP) return document.getElementById("ph-in").focus();
    S.phone=ph; go(4);
  });
  document.getElementById("hnote").classList.toggle("show",S.health.length>0);
}
const PAYS=[{id:"tabby",n:"تابي",d:"قسّطي المبلغ على دفعات بدون فوائد"},{id:"tamara",n:"تمارا",d:"قسّطي المبلغ على دفعات بدون فوائد"},{id:"card",n:"مدى، Apple Pay، أو بطاقة ائتمانية",d:"ادفعي المبلغ كامل عند التأكيد"}];
function totalLine(s){
  if(S.discount) return `<div><span>الإجمالي</span><b class="tot"><span style="text-decoration:line-through;color:var(--muted);font-size:14px;margin-inline-end:8px">${fmtN(s.price)}</span>${fmtN(S.discount.finalPrice)} ريال</b></div>`;
  return `<div><span>الإجمالي</span><b class="tot">${fmtN(s.price)} ريال</b></div>`;
}
function payHint(){
  return isPayLive(S.pay)
    ? '<p class="hint">بعد الضغط على "ادفعي الآن" بتنتقلين لصفحة دفع آمنة لإتمام العملية.</p>'
    : '';
}
function stepPay(){
  const s=svc();
  body.innerHTML=`<div class="recap" id="pay-recap"><div><span>الخدمة</span>${esc(s.name)}</div><div><span>الفرع</span>${esc(br().name)}</div><div><span>الموعد</span>${dLong.format(S.date)}، ${t12(S.time)}</div><div><span>الاسم</span>${esc(S.name)}</div>${totalLine(s)}</div>
  <h3>طريقة الدفع</h3>`+PAYS.map(p=>`<button class="opt" data-v="${p.id}" aria-pressed="${S.pay===p.id}"><span class="dot"></span><span class="t"><b>${p.n}</b><small>${p.d}</small></span></button>`).join("")
  +`<p class="hint" id="pay-hint">${S.pay?payHint():""}</p>`
  +`<div class="field" style="margin-top:18px"><label for="disc-in">كود الخصم (اختياري)</label>
      <div style="display:flex;gap:8px"><input id="disc-in" style="text-transform:uppercase" value="${S.discount?esc(S.discount.code):""}"><button type="button" class="btn btn-ghost" id="disc-apply">تطبيق</button></div>
      <div class="hint" id="disc-msg">${S.discount?`تم تطبيق خصم ${S.discount.percent}%`:""}</div></div>`
  +`<div class="box-note" id="submit-err"></div>`;
  body.querySelectorAll(".opt").forEach(b=>b.onclick=()=>{
    S.pay=b.dataset.v; body.querySelectorAll(".opt").forEach(x=>x.setAttribute("aria-pressed",x===b));
    document.getElementById("pay-hint").innerHTML=payHint();
    footer(true,isPayLive(S.pay)?"ادفعي الآن":"تأكيد الحجز",submitBooking);
    if(S.discount){ S.discount=null; document.getElementById("disc-msg").textContent="غيّرتي طريقة الدفع، طبّقي الكود مرة أخرى"; refreshPayRecap(); }
  });
  document.getElementById("disc-apply").onclick=applyDiscount;
  footer(!!S.pay,S.pay&&isPayLive(S.pay)?"ادفعي الآن":"تأكيد الحجز",submitBooking);
}
function refreshPayRecap(){
  const s=svc();
  const el=document.getElementById("pay-recap");
  if(el) el.innerHTML=`<div><span>الخدمة</span>${esc(s.name)}</div><div><span>الفرع</span>${esc(br().name)}</div><div><span>الموعد</span>${dLong.format(S.date)}، ${t12(S.time)}</div><div><span>الاسم</span>${esc(S.name)}</div>${totalLine(s)}`;
}
async function applyDiscount(){
  const code=val("disc-in").trim();
  const msg=document.getElementById("disc-msg");
  if(!code){ msg.textContent="اكتبي كود الخصم"; return; }
  if(!S.pay){ msg.textContent="اختاري طريقة الدفع أولاً"; return; }
  msg.textContent="نتحقق من الكود...";
  try{
    const r = await api("/discounts/check", {method:"POST", body: JSON.stringify({code, serviceId:S.service, pay:S.pay})});
    S.discount={code:code.toUpperCase(), percent:r.percent, finalPrice:r.finalPrice};
    msg.textContent=`تم تطبيق خصم ${r.percent}%، الإجمالي الجديد ${fmtN(r.finalPrice)} ريال`;
    refreshPayRecap();
  }catch(e){ S.discount=null; msg.textContent=e.message; refreshPayRecap(); }
}
async function submitBooking(){
  if(S.submitting) return;
  S.submitting=true;
  const nextBtn=document.getElementById("next");
  nextBtn.disabled=true; nextBtn.innerHTML='<span class="spin"></span>';
  try{
    const r = await api("/bookings", {method:"POST", body: JSON.stringify({
      serviceId:S.service, branch:S.branch, date:key(S.date), time:S.time,
      name:S.name, phone:S.phone, notes:S.notes, health:S.health, pay:S.pay,
      discountCode: S.discount ? S.discount.code : undefined
    })});
    S.ref=r.ref;
    if(r.paymentUrl){ location.href=r.paymentUrl; return; }
    S.submitting=false;
    if(r.paymentError){
      go(5);
      body.insertAdjacentHTML("afterbegin",'<div class="box-note show">تم حفظ حجزك، لكن تعذر فتح صفحة الدفع الآن. راسلينا على الواتساب برقم الحجز لإتمام الدفع.</div>');
      return;
    }
    go(5);
  }catch(e){
    S.submitting=false;
    const box=document.getElementById("submit-err");
    if(/غير متاح/.test(e.message)){
      availCache.delete(S.branch+":"+S.date.getFullYear()+"-"+(S.date.getMonth()+1));
      S.time=null; S.step=2; render();
      body.insertAdjacentHTML("afterbegin",`<div class="box-note show">${esc(e.message)}، اختاري وقت آخر.</div>`);
    } else if(box){
      box.textContent=e.message; box.classList.add("show");
      nextBtn.disabled=false; nextBtn.textContent="تأكيد الحجز";
    }
  }
}
function stepDone(){
  const s=svc(), payN=PAYS.find(p=>p.id===S.pay).n;
  const finalPrice = S.discount ? S.discount.finalPrice : s.price;
  const msg=encodeURIComponent(`مرحبا، حجزت ${s.name} في فرع ${br().name} يوم ${dLong.format(S.date)} الساعة ${t12(S.time)}. رقم الحجز ${S.ref}`);
  body.innerHTML=`<div class="done"><div class="tick"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
  <h3>تم استلام طلب حجزك</h3><div class="ref">رقم الحجز <span dir="ltr">${esc(S.ref)}</span></div>
  <div class="recap"><div><span>الخدمة</span>${esc(s.name)}</div><div><span>الفرع</span>${esc(br().name)}</div><div><span>الموعد</span>${dLong.format(S.date)}، ${t12(S.time)}</div><div><span>طريقة الدفع</span>${payN}</div><div><span>المبلغ</span>${fmtN(finalPrice)} ريال</div></div>
  <p class="hint" style="margin-bottom:18px">سيتواصل معك فريقنا على الواتساب قريباً لتأكيد الحجز وإتمام الدفع، مع موقع الفرع وتعليمات التحضير.</p></div>`;
  foot.innerHTML=`<a class="btn btn-ghost" style="flex:1" href="https://wa.me/${WA}?text=${msg}" target="_blank" rel="noopener">راسلينا على الواتساب</a><button class="btn btn-rose" style="flex:1" data-close>تم</button>`;
}

/* account */
const asheet=document.getElementById("asheet"), abody=document.getElementById("abody"), afoot=document.getElementById("afoot");
let AV="login"; // login | signup | account
let PENDING_BOOKING=null; // {service,branch} to open right after a gated login succeeds
const AVATAR_SVG=`<svg class="a-avatar" viewBox="0 0 200 200" role="img" aria-label="Microblading By Hebah"><defs><radialGradient id="avGrad" cx="35%" cy="30%" r="80%"><stop offset="0%" stop-color="var(--rose)"/><stop offset="100%" stop-color="var(--rose-deep)"/></radialGradient></defs><circle cx="100" cy="100" r="100" fill="url(#avGrad)"/><text x="97" y="122" text-anchor="middle" font-family="Marcellus,serif" font-size="108" fill="var(--cream)">H</text></svg>`;
function updateAccountBtn(){
  const el = document.getElementById("account-btn-label");
  if(el) el.textContent = CURRENT_CUSTOMER ? "حسابي" : "دخول";
}
async function refreshMe(){
  try{ const r=await api("/customers/me"); CURRENT_CUSTOMER = r.authenticated ? r.customer : null; }
  catch(e){ CURRENT_CUSTOMER=null; }
  updateAccountBtn();
}
refreshMe();

function aOpen(gate){
  PENDING_BOOKING = gate || null;
  AV = CURRENT_CUSTOMER ? "account" : "login";
  asheet.classList.add("open"); asheet.setAttribute("aria-hidden","false"); document.body.style.overflow="hidden"; aRender();
}
function aClose(){ asheet.classList.remove("open"); asheet.setAttribute("aria-hidden","true"); document.body.style.overflow=""; PENDING_BOOKING=null; }
document.addEventListener("click",e=>{ if(e.target.closest("[data-account]")){ e.preventDefault(); aOpen(); } if(e.target.closest("[data-aclose]")) aClose(); });
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&asheet.classList.contains("open")) aClose();});

function onAuthed(){
  updateAccountBtn();
  if(PENDING_BOOKING){
    const gate=PENDING_BOOKING; PENDING_BOOKING=null;
    aClose(); open(gate);
  } else { AV="account"; aRender(); }
}
function aRender(){
  afoot.innerHTML="";
  if(AV==="account") return aRenderAccount();
  if(AV==="signup") return aRenderSignup();
  return aRenderLogin();
}
function gateNote(){
  return PENDING_BOOKING ? '<p class="a-gate-note">سجّلي دخولك أو أنشئي حساب لتكملي حجزك — نحفظ لك حجوزاتك كلها بمكان وحد.</p>' : "";
}
function aRenderLogin(){
  document.getElementById("a-title").textContent="تسجيل الدخول";
  abody.innerHTML=`<div class="aview">${AVATAR_SVG}<div class="a-head"><h3>مرحباً بعودتك</h3><p>سجّلي دخولك لمتابعة حجوزاتك</p></div>
  ${gateNote()}
  <div class="field" id="a-f-phone"><label for="a-ph">رقم الجوال</label><input id="a-ph" inputmode="numeric" dir="ltr" style="text-align:right" placeholder="05xxxxxxxx" autocomplete="tel"><div class="err">رقم جوال غير صحيح</div></div>
  <div class="field" id="a-f-pass"><label for="a-pw">كلمة المرور</label><input id="a-pw" type="password" autocomplete="current-password"><div class="err">اكتبي كلمة المرور</div></div>
  <div class="box-note" id="a-err"></div>
  <p class="a-switch">ما عندك حساب؟ <a href="#" id="a-to-signup">سجّلي واحد جديد</a></p></div>`;
  document.getElementById("a-to-signup").onclick=(e)=>{e.preventDefault(); AV="signup"; aRender();};
  afoot.innerHTML=`<button class="btn btn-rose" style="flex:1" id="a-submit">دخول</button>`;
  document.getElementById("a-submit").onclick=async()=>{
    const phone=toLatin(val("a-ph")), password=val("a-pw");
    const okP=/^05\d{8}$/.test(phone);
    document.getElementById("a-f-phone").classList.toggle("bad",!okP);
    if(!okP) return;
    const btn=document.getElementById("a-submit"); btn.disabled=true; btn.innerHTML='<span class="spin"></span>';
    try{
      const r=await api("/customers/login",{method:"POST",body:JSON.stringify({phone,password})});
      CURRENT_CUSTOMER=r.customer; onAuthed();
    }catch(e){
      const box=document.getElementById("a-err"); box.textContent=e.message; box.classList.add("show");
      btn.disabled=false; btn.textContent="دخول";
    }
  };
}
function aRenderSignup(){
  document.getElementById("a-title").textContent="حساب جديد";
  const maxDob=new Date(); maxDob.setFullYear(maxDob.getFullYear()-10);
  abody.innerHTML=`<div class="aview">${AVATAR_SVG}<div class="a-head"><h3>انشئي حسابك</h3><p>خطوة وحدة قبل ما نبدأ حجزك</p></div>
  ${gateNote()}
  <div class="field" id="a-f-name"><label for="a-nm">الاسم</label><input id="a-nm" autocomplete="name"><div class="err">اكتبي اسمك</div></div>
  <div class="field" id="a-f-phone"><label for="a-ph">رقم الجوال</label><input id="a-ph" inputmode="numeric" dir="ltr" style="text-align:right" placeholder="05xxxxxxxx" autocomplete="tel"><div class="err">رقم جوال غير صحيح</div></div>
  <div class="field" id="a-f-dob"><label for="a-dob">تاريخ الميلاد</label><input id="a-dob" type="date" max="${maxDob.toISOString().slice(0,10)}"><div class="err">تاريخ ميلاد غير صحيح</div></div>
  <div class="field" id="a-f-pass"><label for="a-pw">كلمة المرور</label><input id="a-pw" type="password" autocomplete="new-password"><div class="err">٦ خانات على الأقل</div></div>
  <div class="box-note" id="a-err"></div>
  <p class="a-switch">عندك حساب؟ <a href="#" id="a-to-login">سجّلي دخولك</a></p></div>`;
  document.getElementById("a-to-login").onclick=(e)=>{e.preventDefault(); AV="login"; aRender();};
  afoot.innerHTML=`<button class="btn btn-rose" style="flex:1" id="a-submit">إنشاء حساب</button>`;
  document.getElementById("a-submit").onclick=async()=>{
    const name=val("a-nm").trim(), phone=toLatin(val("a-ph")), password=val("a-pw"), dob=val("a-dob");
    const okN=name.length>=2, okP=/^05\d{8}$/.test(phone), okPw=password.length>=6, okDob=!!dob;
    document.getElementById("a-f-name").classList.toggle("bad",!okN);
    document.getElementById("a-f-phone").classList.toggle("bad",!okP);
    document.getElementById("a-f-dob").classList.toggle("bad",!okDob);
    document.getElementById("a-f-pass").classList.toggle("bad",!okPw);
    if(!okN||!okP||!okDob||!okPw) return;
    const btn=document.getElementById("a-submit"); btn.disabled=true; btn.innerHTML='<span class="spin"></span>';
    try{
      const r=await api("/customers/signup",{method:"POST",body:JSON.stringify({name,phone,password,dob})});
      CURRENT_CUSTOMER=r.customer; onAuthed();
    }catch(e){
      const box=document.getElementById("a-err"); box.textContent=e.message; box.classList.add("show");
      btn.disabled=false; btn.textContent="إنشاء حساب";
    }
  };
}
async function aRenderAccount(){
  document.getElementById("a-title").textContent="حسابي";
  abody.innerHTML=`<div class="aview"><p class="hint" style="margin-top:0">${esc(CURRENT_CUSTOMER.name)} · <span dir="ltr">${esc(CURRENT_CUSTOMER.phone)}</span></p><h3>حجوزاتي</h3><div id="a-bookings"><p class="hint">نحمّل حجوزاتك...</p></div></div>`;
  afoot.innerHTML=`<button class="btn btn-ghost" style="flex:1" id="a-logout">تسجيل الخروج</button>`;
  document.getElementById("a-logout").onclick=async()=>{
    await api("/customers/logout",{method:"POST"});
    CURRENT_CUSTOMER=null; updateAccountBtn(); AV="login"; aRender();
  };
  let list=[];
  try{ list=await api("/customers/bookings"); }catch(e){}
  const el=document.getElementById("a-bookings");
  if(!list.length){ el.innerHTML='<p class="hint">ما سويتي أي حجز بعد.</p>'; return; }
  el.innerHTML=list.map(b=>{
    const price = b.discount ? b.discount.percent+'% خصم، '+fmtN(b.price)+' ريال' : fmtN(b.price)+' ريال';
    let actions="";
    if(b.canCancel) actions+=`<button class="btn btn-ghost btn-sm" data-cancel="${b.id}">إلغاء الحجز</button>`;
    else if(b.canRequestReschedule) actions+= b.rescheduleRequested ? '<span class="hint">تم إرسال طلب التأجيل، بننسق وياك على الواتساب</span>' : `<button class="btn btn-ghost btn-sm" data-resched="${b.id}">طلب تأجيل</button>`;
    return `<div class="recap" style="margin-bottom:12px"><div><span>الخدمة</span>${esc(b.serviceName)}</div><div><span>الفرع</span>${esc(b.branchName)}</div><div><span>الموعد</span>${dLong.format(new Date(b.date.split('-')[0],b.date.split('-')[1]-1,b.date.split('-')[2]))}، ${t12(b.time)}</div><div><span>الحالة</span><span class="latin" dir="ltr">${({pending:"قيد الانتظار",confirmed:"مؤكد",cancelled:"ملغي",done:"مكتمل"})[b.status]}</span></div><div><span>المبلغ</span>${price}</div></div>${actions?`<div style="margin:-6px 0 16px">${actions}</div>`:""}`;
  }).join("");
  el.querySelectorAll("[data-cancel]").forEach(btn=>btn.addEventListener("click",async()=>{
    if(!confirm("تأكيد إلغاء هذا الحجز؟")) return;
    try{ await api(`/customers/bookings/${btn.dataset.cancel}/cancel`,{method:"POST"}); aRenderAccount(); }catch(e){ alert(e.message); }
  }));
  el.querySelectorAll("[data-resched]").forEach(btn=>btn.addEventListener("click",async()=>{
    try{ await api(`/customers/bookings/${btn.dataset.resched}/request-reschedule`,{method:"POST"}); aRenderAccount(); }catch(e){ alert(e.message); }
  }));
}
