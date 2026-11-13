const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const SESSION_TTL_SEC = 12 * 60 * 60;

// Two independent session scopes share this factory: the single admin account
// and customer accounts. Each gets its own Redis key prefix (or, locally
// without Redis, its own in-memory Map) so a session token from one scope
// can never be replayed against the other.
function makeSessionStore(prefix) {
  const mem = new Map();

  function create() {
    const token = crypto.randomBytes(32).toString("hex");
    if (db.usingRedis()) {
      return db.redisClient().set(prefix + token, "1", { ex: SESSION_TTL_SEC }).then(() => token);
    }
    mem.set(token, Date.now() + SESSION_TTL_SEC * 1000);
    return Promise.resolve(token);
  }

  async function touch(token) {
    if (!token) return false;
    if (db.usingRedis()) {
      const exists = await db.redisClient().get(prefix + token);
      if (!exists) return false;
      await db.redisClient().expire(prefix + token, SESSION_TTL_SEC);
      return true;
    }
    const exp = mem.get(token);
    if (!exp || exp < Date.now()) { mem.delete(token); return false; }
    mem.set(token, Date.now() + SESSION_TTL_SEC * 1000);
    return true;
  }

  async function destroy(token) {
    if (!token) return;
    if (db.usingRedis()) await db.redisClient().del(prefix + token);
    else mem.delete(token);
  }

  return { create, touch, destroy };
}

// ---------- admin ----------
const adminSessions = makeSessionStore("sess:");

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
  const ok = await adminSessions.touch(token);
  if (!ok) return res.status(401).json({ error: "تحتاجين تسجيل الدخول" });
  next();
}

// ---------- customers ----------
const customerSessions = makeSessionStore("csess:");
// Maps a live session token to the customer id it belongs to, so a request
// handler can know *which* customer is calling, not just "someone is".
const customerIdBySession = new Map();
const CUSTOMER_SESSION_KEY_PREFIX = "csess:id:";

async function createCustomerSession(customerId) {
  const token = await customerSessions.create();
  if (db.usingRedis()) {
    await db.redisClient().set(CUSTOMER_SESSION_KEY_PREFIX + token, customerId, { ex: SESSION_TTL_SEC });
  } else {
    customerIdBySession.set(token, customerId);
  }
  return token;
}

async function getCustomerIdFromSession(token) {
  if (!token) return null;
  const ok = await customerSessions.touch(token);
  if (!ok) return null;
  if (db.usingRedis()) {
    const id = await db.redisClient().get(CUSTOMER_SESSION_KEY_PREFIX + token);
    if (id) await db.redisClient().expire(CUSTOMER_SESSION_KEY_PREFIX + token, SESSION_TTL_SEC);
    return id || null;
  }
  return customerIdBySession.get(token) || null;
}

async function destroyCustomerSession(token) {
  await customerSessions.destroy(token);
  if (db.usingRedis()) await db.redisClient().del(CUSTOMER_SESSION_KEY_PREFIX + token);
  else customerIdBySession.delete(token);
}

async function requireCustomerAuth(req, res, next) {
  const token = req.cookies && req.cookies.customer_session;
  const customerId = await getCustomerIdFromSession(token);
  if (!customerId) return res.status(401).json({ error: "تحتاجين تسجيل الدخول" });
  req.customerId = customerId;
  next();
}

module.exports = {
  createSession: adminSessions.create,
  touchSession: adminSessions.touch,
  destroySession: adminSessions.destroy,
  verifyPassword,
  setPassword,
  requireAuth,
  createCustomerSession,
  getCustomerIdFromSession,
  destroyCustomerSession,
  requireCustomerAuth
};
