const HORIZON_DAYS = 60;
const SLOT_STEP_MIN = 15;
const RETOUCH_DURATION_MIN = 15;

function dateKey(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function timeToMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minToTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function durationFor(db, serviceId) {
  const s = (db.services || []).find(x => x.id === serviceId);
  return (s && s.durationMin) || RETOUCH_DURATION_MIN;
}

// Returns { from, to } (as "HH:MM") open hours for a branch+date, honoring a
// date override (closed day, or a one-off custom range) over the recurring
// weekly template. Returns null when the branch is closed that day.
function rangeForDate(db, branchId, date) {
  const sched = db.schedule[branchId];
  if (!sched) return null;
  const key = dateKey(date);
  const override = (db.overrides[branchId] || {})[key];
  if (override && override.closed) return null;
  if (override && override.range) return override.range;
  return (sched.ranges && sched.ranges[date.getDay()]) || null;
}

// A booking sent to a real payment gateway only holds its slot for this long
// unpaid — long enough to finish a checkout, short enough that an abandoned
// payment doesn't block the calendar forever. Bookings with no gateway
// attached (cash, bank transfer, or a method not configured yet) hold the
// slot the old way, indefinitely.
const UNPAID_HOLD_MINUTES = 20;

function isHoldingSlot(b) {
  if (b.status === "cancelled") return false;
  if (!b.gateway || b.paid) return true;
  const ageMinutes = (Date.now() - new Date(b.createdAt).getTime()) / 60000;
  return ageMinutes < UNPAID_HOLD_MINUTES;
}

// How many existing bookings on this branch+date occupy any part of
// [startMin, endMin) — the interval-overlap check that replaced simple
// same-start-time counting once services had real durations.
function overlappingCount(db, branchId, dateKeyStr, startMin, endMin, excludeId) {
  let count = 0;
  for (const b of db.bookings) {
    if (b.id === excludeId) continue;
    if (b.branch !== branchId || b.date !== dateKeyStr) continue;
    if (!isHoldingSlot(b)) continue;
    const bStart = timeToMin(b.time);
    const bEnd = bStart + durationFor(db, b.serviceId);
    if (bStart < endMin && startMin < bEnd) count++;
  }
  return count;
}

// Builds { "YYYY-MM-DD": [{time, available}] } for every day in [today, today+HORIZON_DAYS]
// that has open hours, restricted to a single month if year/month given.
// Start times are generated on a 15-minute grid and only offered when the
// full service duration fits before closing time and doesn't overlap more
// than `capacity` other bookings.
function availabilityForMonth(db, branchId, year, month, serviceId) {
  const today = startOfDay(new Date());
  const horizon = startOfDay(new Date());
  horizon.setDate(horizon.getDate() + HORIZON_DAYS);

  const firstOfMonth = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const capacity = (db.schedule[branchId] && db.schedule[branchId].capacity) || 1;
  const duration = durationFor(db, serviceId);

  const out = {};
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month - 1, day);
    if (d < today || d > horizon) continue;
    const range = rangeForDate(db, branchId, d);
    if (!range) continue;
    const key = dateKey(d);
    const startMin = timeToMin(range.from), endMin = timeToMin(range.to);
    const times = [];
    for (let t = startMin; t + duration <= endMin; t += SLOT_STEP_MIN) {
      times.push({ time: minToTime(t), available: overlappingCount(db, branchId, key, t, t + duration) < capacity });
    }
    if (times.length) out[key] = times;
  }
  return out;
}

function isSlotAvailable(db, branchId, dateStr, time, serviceId, excludeId) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = startOfDay(new Date());
  if (startOfDay(date) < today) return false;
  const range = rangeForDate(db, branchId, date);
  if (!range) return false;
  const duration = durationFor(db, serviceId);
  const startMin = timeToMin(time), endMin = startMin + duration;
  if (startMin < timeToMin(range.from) || endMin > timeToMin(range.to)) return false;
  const capacity = (db.schedule[branchId] && db.schedule[branchId].capacity) || 1;
  return overlappingCount(db, branchId, dateStr, startMin, endMin, excludeId) < capacity;
}

module.exports = {
  availabilityForMonth, isSlotAvailable, dateKey, HORIZON_DAYS,
  timeToMin, minToTime, durationFor, isHoldingSlot, RETOUCH_DURATION_MIN
};
