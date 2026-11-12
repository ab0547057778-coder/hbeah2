const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const SESSION_TTL_SEC = 12 * 60 * 60;

// In-memory fallback for local dev (no Redis configured). On Vercel, every
// invocation can land on a different instance, so this Map would not be
// shared between requests — that's why createSession/touchSession below
// switch to Redis automatically whenever db.usingRedis() is true.
const memSessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  if (db.usingRedis()) {
    return db.redisClient().set("sess:" + token, "1", { ex: SESSION_TTL_SEC }).then(() => token);
  }
  memSessions.set(token, Date.now() + SESSION_TTL_SEC * 1000);
  return Promise.resolve(token);
}

async function touchSession(token) {
  if (!token) return false;
  if (db.usingRedis()) {
    const exists = await db.redisClient().get("sess:" + token);
    if (!exists) return false;
    await db.redisClient().expire("sess:" + token, SESSION_TTL_SEC);
    return true;
  }
  const exp = memSessions.get(token);
  if (!exp || exp < Date.now()) { memSessions.delete(token); return false; }
  memSessions.set(token, Date.now() + SESSION_TTL_SEC * 1000);
  return true;
}

async function destroySession(token) {
  if (!token) return;
  if (db.usingRedis()) await db.redisClient().del("sess:" + token);
  else memSessions.delete(token);
}

async function verifyPassword(password) {
  const data = await db.getData();
  return bcrypt.compareSync(String(password || ""), data.config.adminPasswordHash);
}

async function setPassword(newPassword) {
  const hash = bcrypt.hashSync(String(newPassword), 10);
  await db.mutate(data => { data.config.adminPasswordHash = hash; });
}

async function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.admin_session;
  const ok = await touchSession(token);
  if (!ok) return res.status(401).json({ error: "تحتاجين تسجيل الدخول" });
  next();
}

module.exports = { createSession, touchSession, destroySession, verifyPassword, setPassword, requireAuth };
