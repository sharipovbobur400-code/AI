'use strict';
// Core primitives: clock, errors, validation, event bus.
const { EventEmitter } = require('node:events');

let fixedNow = null;
const clock = {
  now: () => (fixedNow ? new Date(fixedNow) : new Date()),
  set(d) { fixedNow = d ? new Date(d).getTime() : null; },
  advance(ms) { if (fixedNow) fixedNow += ms; },
  iso() { return clock.now().toISOString(); },
  today() { return clock.iso().slice(0, 10); },
  addDays(days, from) { const d = from ? new Date(from) : clock.now(); d.setTime(d.getTime() + days * 86400000); return d.toISOString(); },
};

class AppError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const bad = (m, d) => new AppError(400, m, d);
const notFound = (what) => new AppError(404, `${what} topilmadi`);
const forbidden = (m) => new AppError(403, m || 'Ushbu amal uchun ruxsat yo‘q');
const conflict = (m, d) => new AppError(409, m, d);

const bus = new EventEmitter();
bus.setMaxListeners(2000);

// ---- Validation -------------------------------------------------------------
const V = {
  str(v, name, { required = true, max = 500, min = 0 } = {}) {
    if (v === undefined || v === null || v === '') { if (required) throw bad(`"${name}" majburiy maydon`); return null; }
    if (typeof v !== 'string' && typeof v !== 'number') throw bad(`"${name}" noto‘g‘ri formatda`);
    const s = String(v).trim();
    if (required && !s) throw bad(`"${name}" majburiy maydon`);
    if (s.length > max) throw bad(`"${name}" juda uzun (max ${max})`);
    if (s.length < min) throw bad(`"${name}" juda qisqa (min ${min})`);
    return s;
  },
  num(v, name, { required = true, min = -Infinity, max = Infinity, int = false, positive = false } = {}) {
    if (v === undefined || v === null || v === '') { if (required) throw bad(`"${name}" majburiy maydon`); return null; }
    const n = Number(v);
    if (!Number.isFinite(n)) throw bad(`"${name}" son bo‘lishi kerak`);
    if (int && !Number.isInteger(n)) throw bad(`"${name}" butun son bo‘lishi kerak`);
    if (positive && !(n > 0)) throw bad(`"${name}" musbat bo‘lishi kerak`);
    if (n < min) throw bad(`"${name}" ${min} dan kichik bo‘lmasligi kerak`);
    if (n > max) throw bad(`"${name}" ${max} dan katta bo‘lmasligi kerak`);
    return n;
  },
  qty(v, name = 'Miqdor') { return V.num(v, name, { positive: true, max: 1e9 }); },
  id(v, name) { return V.num(v, name, { int: true, min: 1 }); },
  optId(v, name) { return V.num(v, name, { required: false, int: true, min: 1 }); },
  oneOf(v, name, list, { required = true } = {}) {
    if (v === undefined || v === null || v === '') { if (required) throw bad(`"${name}" majburiy maydon`); return null; }
    if (!list.includes(v)) throw bad(`"${name}" qiymati noto‘g‘ri: ${v}`);
    return v;
  },
  date(v, name, { required = true } = {}) {
    if (!v) { if (required) throw bad(`"${name}" majburiy maydon`); return null; }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw bad(`"${name}" sana noto‘g‘ri`);
    return d.toISOString();
  },
  arr(v, name, { required = true, max = 1000 } = {}) {
    if (!Array.isArray(v) || (required && !v.length)) throw bad(`"${name}" ro‘yxati bo‘sh`);
    if (v.length > max) throw bad(`"${name}" juda ko‘p element`);
    return v;
  },
};

const round = (n, d = 2) => Math.round((Number(n) + Number.EPSILON) * 10 ** d) / 10 ** d;
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU').replace(/ /g, ' ');

module.exports = { clock, AppError, bad, notFound, forbidden, conflict, bus, V, round, fmt };
