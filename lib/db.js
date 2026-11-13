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
      { id: "mb", name: "مايكروبليدينق", en: "Microblading", price: 1800, desc: "شعيرات دقيقة مرسومة باليد تشبه شعر الحاجب الطبيعي، تملأ الفراغات وتعطي شكل متناسق مع ملامحك.", active: true },
      { id: "ms", name: "مايكروشيدينق", en: "Microshading", price: 2500, desc: "تظليل ناعم بنقاط دقيقة يعطي مظهر البودرة، لمن تحب حاجب مكتمل ومحدد.", active: true },
      { id: "lb", name: "توريد شفايف", en: "Lip Blush", price: 1350, desc: "لون وردي طبيعي يحدد الشفايف ويوحّد لونها.", active: true },
      { id: "ln", name: "تفتيح شفايف", en: "Lip Neutralization", price: 650, desc: "يخفف اللون الغامق في الشفايف ويقرّبها للونها الوردي.", active: true },
      { id: "bm", name: "حبة الخال", en: "Beauty Mark", price: 150, desc: "شامة صغيرة بالمكان والحجم اللي تختارينه.", active: true }
    ],
    schedule: {
      dmm: { weekdays: [6, 0, 1], slots: ["14:00", "16:30", "19:00"], capacity: 1 },
      hsa: { weekdays: [3, 4], slots: ["14:00", "16:30", "19:00"], capacity: 1 }
      // ryd (الرياض) has no schedule yet — set its weekly hours from the admin
      // dashboard's "الأوقات المتاحة" tab once Hebah decides them; until then it
      // just shows no availability instead of guessed hours.
    },
    overrides: { dmm: {}, hsa: {}, ryd: {} },
    discounts: [],
    bookings: [],
    customers: []
  };
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
