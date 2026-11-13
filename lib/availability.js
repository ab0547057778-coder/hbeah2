const HORIZON_DAYS = 60;

function dateKey(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Returns the slot list that applies to a given branch+date, honoring date overrides
// (closed day, or a custom slot list) over the recurring weekly template.
function slotsForDate(db, branchId, date) {
  const sched = db.schedule[branchId];
  if (!sched) return [];
  const key = dateKey(date);
  const override = (db.overrides[branchId] || {})[key];
  if (override && override.closed) return [];
  if (override && Array.isArray(override.slots)) return override.slots;
  if (!sched.weekdays.includes(date.getDay())) return [];
  return sched.slots;
}

// A booking sent to a real payment gateway only holds its slot for this long
// unpaid — long enough to finish a checkout, short enough that an abandoned
// payment doesn't block the calendar forever. Bookings with no gateway
// attached (gateway wasn't configured yet for that method) hold the slot
// the old way, indefinitely, same as before payments existed.
const UNPAID_HOLD_MINUTES = 20;

function isHoldingSlot(b) {
  if (b.status === "cancelled") return false;
  if (!b.gateway || b.paid) return true;
  const ageMinutes = (Date.now() - new Date(b.createdAt).getTime()) / 60000;
  return ageMinutes < UNPAID_HOLD_MINUTES;
}

function bookedCount(db, branchId, dateKeyStr, time) {
  return db.bookings.filter(
    b => b.branch === branchId && b.date === dateKeyStr && b.time === time && isHoldingSlot(b)
  ).length;
}

// Builds { "YYYY-MM-DD": [{time, available}] } for every day in [today, today+HORIZON_DAYS]
// that has at least one slot configured, restricted to a single month if year/month given.
function availabilityForMonth(db, branchId, year, month) {
  const today = startOfDay(new Date());
  const horizon = startOfDay(new Date());
  horizon.setDate(horizon.getDate() + HORIZON_DAYS);

  const firstOfMonth = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const capacity = (db.schedule[branchId] && db.schedule[branchId].capacity) || 1;

  const out = {};
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month - 1, day);
    if (d < today || d > horizon) continue;
    const slots = slotsForDate(db, branchId, d);
    if (!slots.length) continue;
    const key = dateKey(d);
    out[key] = slots.map(t => ({
      time: t,
      available: bookedCount(db, branchId, key, t) < capacity
    }));
  }
  return out;
}

function isSlotAvailable(db, branchId, dateStr, time) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = startOfDay(new Date());
  if (startOfDay(date) < today) return false;
  const slots = slotsForDate(db, branchId, date);
  if (!slots.includes(time)) return false;
  const capacity = (db.schedule[branchId] && db.schedule[branchId].capacity) || 1;
  return bookedCount(db, branchId, dateStr, time) < capacity;
}

module.exports = { availabilityForMonth, isSlotAvailable, dateKey, HORIZON_DAYS };
