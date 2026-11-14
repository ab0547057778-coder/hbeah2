const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const DB_PATH = path.join(__dirname, "..", "data", "db.json");
const DOC_KEY = "hebah:db";

// Works two ways depending on environment:
// - Local dev (no Redis env vars): reads/writes data/db.json on disk.
// - Deployed on Vercel with a Redis integration (Upstash) connected: stores the
//   same JSON document under one key in Redis, since serverless functions don't
//   share a writable, persistent filesystem across invocations.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
let redis = null;
if (REDIS_URL && REDIS_TOKEN) {
  const { Redis } = require("@upstash/redis");
  redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
}

function genPassword() {
  return crypto.randomBytes(6).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "Hebah2026";
}

function defaultData() {
  // Without ADMIN_PASSWORD set and without Redis connected, every cold start
  // would otherwise get its own random password — unusable for a real deploy.
  const plain = process.env.ADMIN_PASSWORD || genPassword();
  const hash = bcrypt.hashSync(plain, 10);
  if (!process.env.ADMIN_PASSWORD) {
    // eslint-disable-next-line no-console
    console.log("\n==============================================");
    console.log(" تم إنشاء كلمة مرور الأدمن الافتراضية لأول مرة:");
    console.log(" Admin password (change it after first login): " + plain);
    console.log(" لتثبيت كلمة مرور دائمة، أضيفي متغير البيئة ADMIN_PASSWORD.");
    console.log("==============================================\n");
  }
  return {
    config: {
      adminPasswordHash: hash,
      sessionSecret: crypto.randomBytes(32).toString("hex")
    },
    branches: [
      { id: "dmm", name: "الدمام" },
      { id: "hsa", name: "الأحساء" },
      { id: "ryd", name: "الرياض" }
    ],
    services: [
      { id: "mb", name: "مايكروبليدينق", en: "Microblading", price: 1800, durationMin: 45, desc: "شعيرات دقيقة مرسومة باليد تحاكي شعر الحاجب الطبيعي، تملأ الفراغات وتمنح الحاجبين شكلاً متناسقاً مع ملامح الوجه.", active: true },
      { id: "ms", name: "مايكروشيدينق", en: "Microshading", price: 2500, durationMin: 60, desc: "تظليل ناعم بنقاط دقيقة يمنح الحاجبين مظهر البودرة، مناسب لمن ترغب بحاجب مكتمل ومحدد الشكل.", active: true },
      { id: "lb", name: "توريد الشفاه", en: "Lip Blush", price: 1350, durationMin: 90, desc: "لون وردي طبيعي يحدد ملامح الشفاه ويوحّد لونها.", active: true },
      { id: "ln", name: "تفتيح الشفاه", en: "Lip Neutralization", price: 650, durationMin: 60, desc: "يخفف اللون الداكن في الشفاه ويقرّبه من اللون الوردي الطبيعي.", active: true },
      { id: "bm", name: "حبة الخال", en: "Beauty Mark", price: 150, durationMin: 15, desc: "شامة صغيرة بالمكان والحجم الذي تختارينه.", active: true },
      { id: "retouch", name: "جلسة الرتوش", en: "Touch-up", price: 0, durationMin: 15, desc: "جلسة رتوش مجانية لعميلات المايكروبليدينق والمايكروشيدينق.", active: true, hidden: true }
    ],
    // Each branch's weekly hours: ranges[weekday] = {from,to} ("HH:MM"); a
    // weekday with no entry is closed. capacity = how many appointments can
    // run at the same time (chairs/staff available simultaneously).
    schedule: {
      dmm: { ranges: { 6: { from: "14:00", to: "20:00" }, 0: { from: "14:00", to: "20:00" }, 1: { from: "14:00", to: "20:00" } }, capacity: 1 },
      hsa: { ranges: { 3: { from: "14:00", to: "20:00" }, 4: { from: "14:00", to: "20:00" } }, capacity: 1 }
      // ryd (الرياض) has no schedule yet — set its weekly hours from the admin
      // dashboard's "الأوقات المتاحة" tab once Hebah decides them; until then it
      // just shows no availability instead of guessed hours.
    },
    overrides: { dmm: {}, hsa: {}, ryd: {} },
    discounts: [],
    bookings: [],
    customers: [],
    offers: []
  };
}

// Backfills top-level fields added to the schema after a database was first
// created, so an already-deployed Redis/file document doesn't crash on
// features released later. Returns true if anything was added.
function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + mins;
  return String(Math.floor(total / 60) % 24).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
}

function migrate(data) {
  let changed = false;
  if (!Array.isArray(data.customers)) { data.customers = []; changed = true; }
  if (!Array.isArray(data.discounts)) { data.discounts = []; changed = true; }
  if (!Array.isArray(data.bookings)) { data.bookings = []; changed = true; }
  if (!Array.isArray(data.offers)) { data.offers = []; changed = true; }
  if (!data.overrides) { data.overrides = {}; changed = true; }
  for (const b of data.branches || []) {
    if (!data.overrides[b.id]) { data.overrides[b.id] = {}; changed = true; }
  }
  const KNOWN_DURATIONS = { mb: 45, ms: 60, lb: 90, ln: 60, bm: 15, retouch: 15 };
  for (const s of data.services || []) {
    if (!s.durationMin) { s.durationMin = KNOWN_DURATIONS[s.id] || 60; changed = true; }
  }
  if (!(data.services || []).some(s => s.id === "retouch")) {
    data.services.push({ id: "retouch", name: "جلسة الرتوش", en: "Touch-up", price: 0, durationMin: 15, desc: "جلسة رتوش مجانية لعميلات المايكروبليدينق والمايكروشيدينق.", active: true, hidden: true });
    changed = true;
  }
  // One-time copy fix: a document created before the Fus-ha pass still has
  // the original colloquial name/description text baked in — this file
  // only seeds a brand-new document, so already-persisted services never
  // picked up the rewrite. Replace only exact matches of the old known
  // text, so anything Hebah has since edited herself is left untouched.
  const OLD_COPY = {
    mb: { name: "مايكروبليدينق", desc: "شعيرات دقيقة مرسومة باليد تشبه شعر الحاجب الطبيعي، تملأ الفراغات وتعطي شكل متناسق مع ملامحك." },
    ms: { name: "مايكروشيدينق", desc: "تظليل ناعم بنقاط دقيقة يعطي مظهر البودرة، لمن تحب حاجب مكتمل ومحدد." },
    lb: { name: "توريد شفايف", desc: "لون وردي طبيعي يحدد الشفايف ويوحّد لونها." },
    ln: { name: "تفتيح شفايف", desc: "يخفف اللون الغامق في الشفايف ويقرّبها للونها الوردي." },
    bm: { name: "حبة الخال", desc: "شامة صغيرة بالمكان والحجم اللي تختارينه." }
  };
  const NEW_COPY = {
    mb: { name: "مايكروبليدينق", desc: "شعيرات دقيقة مرسومة باليد تحاكي شعر الحاجب الطبيعي، تملأ الفراغات وتمنح الحاجبين شكلاً متناسقاً مع ملامح الوجه." },
    ms: { name: "مايكروشيدينق", desc: "تظليل ناعم بنقاط دقيقة يمنح الحاجبين مظهر البودرة، مناسب لمن ترغب بحاجب مكتمل ومحدد الشكل." },
    lb: { name: "توريد الشفاه", desc: "لون وردي طبيعي يحدد ملامح الشفاه ويوحّد لونها." },
    ln: { name: "تفتيح الشفاه", desc: "يخفف اللون الداكن في الشفاه ويقرّبه من اللون الوردي الطبيعي." },
    bm: { name: "حبة الخال", desc: "شامة صغيرة بالمكان والحجم الذي تختارينه." }
  };
  for (const s of data.services || []) {
    const old = OLD_COPY[s.id], fresh = NEW_COPY[s.id];
    if (old && fresh && s.name === old.name && s.desc === old.desc) {
      s.name = fresh.name; s.desc = fresh.desc; changed = true;
    }
  }
  // Pre-duration schedules stored a flat slot list shared across the checked
  // weekdays — convert each into an equivalent per-weekday open range so the
  // new interval-based availability engine has something to work with. Hebah
  // can tighten the exact hours afterward from the admin schedule editor.
  for (const branchId of Object.keys(data.schedule || {})) {
    const sched = data.schedule[branchId];
    if (sched && Array.isArray(sched.weekdays) && Array.isArray(sched.slots)) {
      const sorted = [...sched.slots].sort();
      const range = sorted.length ? { from: sorted[0], to: addMinutes(sorted[sorted.length - 1], 60) } : null;
      sched.ranges = {};
      if (range) for (const wd of sched.weekdays) sched.ranges[wd] = range;
      delete sched.weekdays;
      delete sched.slots;
      changed = true;
    }
  }
  for (const branchId of Object.keys(data.overrides || {})) {
    for (const key of Object.keys(data.overrides[branchId] || {})) {
      const ov = data.overrides[branchId][key];
      if (ov && Array.isArray(ov.slots)) {
        const sorted = [...ov.slots].sort();
        ov.range = sorted.length ? { from: sorted[0], to: addMinutes(sorted[sorted.length - 1], 60) } : null;
        delete ov.slots;
        changed = true;
      }
    }
  }
  return changed;
}

// ---------- local-file backend (dev) ----------
let fileCache = null;
let fileWriteQueue = Promise.resolve();

function fileLoad() {
  if (fileCache) return fileCache;
  if (!fs.existsSync(DB_PATH)) {
    fileCache = defaultData();
    // Running on a read-only filesystem (e.g. deployed to Vercel without a
    // Redis store connected) — keep going in memory for this invocation
    // instead of crashing; nothing will persist across cold starts though.
    try {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      fs.writeFileSync(DB_PATH, JSON.stringify(fileCache, null, 2), "utf8");
    } catch (e) {
      console.warn("DB file is not writable — running with in-memory data only. Connect a Redis store for real persistence.");
    }
    return fileCache;
  }
  fileCache = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  if (migrate(fileCache)) filePersist();
  return fileCache;
}
function filePersist() {
  if (!fileCache) return Promise.resolve();
  const snapshot = JSON.stringify(fileCache, null, 2);
  fileWriteQueue = fileWriteQueue.then(() => fs.promises.writeFile(DB_PATH, snapshot, "utf8")).catch(() => {});
  return fileWriteQueue;
}

// ---------- redis backend (prod) ----------
let redisCache = null; // per-invocation memo only; source of truth is Redis
async function redisLoad() {
  if (redisCache) return redisCache;
  let data = await redis.get(DOC_KEY);
  if (!data) {
    data = defaultData();
    await redis.set(DOC_KEY, data);
  } else if (migrate(data)) {
    await redis.set(DOC_KEY, data);
  }
  redisCache = data;
  return redisCache;
}
async function redisPersist() {
  await redis.set(DOC_KEY, redisCache);
}

// ---------- public API ----------
// getData(): read-only snapshot of the whole document.
async function getData() {
  return redis ? redisLoad() : fileLoad();
}

// mutate(fn): load, run a synchronous mutator over the in-memory doc, persist,
// and return whatever the mutator returns. Callers use this for every write so
// reads-before-write stay consistent within one request.
async function mutate(fn) {
  const data = redis ? await redisLoad() : fileLoad();
  const result = fn(data);
  if (redis) await redisPersist(); else await filePersist();
  return result;
}

module.exports = { getData, mutate, usingRedis: () => !!redis, redisClient: () => redis };
