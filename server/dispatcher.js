'use strict';
// AI dispatcher: for every packed order without transport it picks the best available vehicle + driver
// (capacity/weight/volume validated), creates the shipment + loading task, contacts the driver on Telegram,
// re-plans automatically when a driver declines or does not answer, and dispatches the cargo out of the warehouse
// when the driver/logistician confirms (mode "assist") or automatically at departure time (mode "auto").
const db = require('./db');
const logi = require('./logistics');
const { clock, bad, notFound, V } = require('./core');

const MODES = ['off', 'assist', 'auto'];
const ACTIVE = ['CONTACTING', 'AWAIT_CONFIRM', 'DRIVER_ACCEPTED'];
const settings = () => ({ mode: db.setting('dispatch_mode', 'assist'), driverTimeoutMin: db.setting('dispatch_driver_timeout_min', 20), leadHours: db.setting('dispatch_lead_hours', 2) });
function sys() { const u = db.get("SELECT id, username, full_name, role_code FROM users WHERE username='ai.dispetcher'"); return u ? { id: u.id, username: u.username, fullName: u.full_name, role: u.role_code } : null; }
const job = (id) => { const j = db.get('SELECT * FROM dispatch_jobs WHERE id=?', id); if (!j) throw notFound('Dispetcher topshirig‘i'); return j; };
const tried = (j) => (j && j.tried ? JSON.parse(j.tried) : { vehicles: [], drivers: [] });
function setJob(id, patch) { db.update('dispatch_jobs', id, { ...patch, updated_at: clock.iso() }); }

function saveSettings(input, user) {
  const mode = V.oneOf(input.mode, 'Rejim', MODES);
  db.setSetting('dispatch_mode', mode);
  if (input.driverTimeoutMin != null) db.setSetting('dispatch_driver_timeout_min', V.num(input.driverTimeoutMin, 'Haydovchi javob muddati', { int: true, min: 2, max: 720 }));
  if (input.leadHours != null) db.setSetting('dispatch_lead_hours', V.num(input.leadHours, 'Tayyorgarlik vaqti', { min: 0, max: 48 }));
  db.audit(user, 'DISPATCH_SETTINGS', 'settings', 'dispatch', settings());
  return settings();
}

/** Plan transport for one order (creates/updates its dispatch job). */
function planOrder(orderId, user) {
  return db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE id=?', orderId); if (!o) throw notFound('Buyurtma');
    if (db.val("SELECT COUNT(*) FROM shipments WHERE order_id=? AND status IN ('PLANNED','LOADING','LOADED')", orderId)) return { skipped: 'active shipment' };
    let j = db.get(`SELECT * FROM dispatch_jobs WHERE order_id=? AND status NOT IN ('DISPATCHED','CANCELLED') ORDER BY id DESC LIMIT 1`, orderId);
    if (j && ACTIVE.includes(j.status)) return { skipped: 'active job' };
    const t = tried(j);
    const calc = logi.calculate({ orderId });
    const vehicles = calc.vehicles.filter((v) => v.fits && v.status === 'AVAILABLE' && !t.vehicles.includes(v.vehicleId)).sort((a, b) => a.payload_kg - b.payload_kg);
    const drivers = db.all("SELECT * FROM drivers WHERE status='AVAILABLE'").filter((d) => !t.drivers.includes(d.id));
    let choice = null;
    for (const v of vehicles) {
      const own = db.val('SELECT driver_id FROM vehicles WHERE id=?', v.vehicleId);
      const d = drivers.find((x) => x.id === own) || drivers.filter((x) => !db.val("SELECT COUNT(*) FROM vehicles WHERE driver_id=? AND status<>'AVAILABLE'", x.id)).sort((a, b) => (b.telegram_chat_id ? 1 : 0) - (a.telegram_chat_id ? 1 : 0))[0];
      if (d) { choice = { v, d }; break; }
    }
    const now = clock.iso();
    if (!j) j = { id: db.insert('dispatch_jobs', { order_id: orderId, status: 'NEW', tried: JSON.stringify(t), created_at: now, updated_at: now }) , attempts: 0 };
    if (!choice) {
      const reason = !calc.vehicles.some((v) => v.fits) ? (calc.split ? calc.split.text : 'Yuk hech bir transportga sig‘maydi') : !vehicles.length ? 'Mos bo‘sh transport yo‘q' : 'Bo‘sh haydovchi yo‘q';
      const first = j.status !== 'NO_TRANSPORT';
      setJob(j.id, { status: 'NO_TRANSPORT', note: reason });
      if (first) {
        require('./ai').raise({ key: `dispatch-${orderId}`, type: 'DISPATCH', severity: 'CRITICAL', title: `Transport topilmadi: ${o.order_no}`, ref_type: 'order', ref_id: orderId,
          message: `AI dispetcher ${o.order_no} (${calc.totals.qty} dona, ${calc.totals.grossWeight} kg, ${calc.totals.palletCount} pallet) uchun transport tayinlay olmadi: ${reason}.` });
        db.emit('DISPATCH_NO_TRANSPORT', { jobId: j.id, orderId, orderNo: o.order_no, reason });
      }
      return { jobId: j.id, status: 'NO_TRANSPORT', reason };
    }
    const due = o.due_date ? new Date(o.due_date) : null;
    const lead = new Date(Date.now() + settings().leadHours * 3600000);
    const planned = (due && due > lead ? due : lead).toISOString();
    const actor = user || sys();
    const sh = db.withUser(actor, () => logi.createShipment({ orderId, vehicleId: choice.v.vehicleId, driverId: choice.d.id, destination: o.destination || 'Manzil ko‘rsatilmagan', plannedDeparture: planned }, actor));
    const status = choice.d.telegram_chat_id ? 'CONTACTING' : 'AWAIT_CONFIRM';
    setJob(j.id, { status, shipment_id: sh.id, vehicle_id: choice.v.vehicleId, driver_id: choice.d.id, planned_at: planned, contacted_at: now, attempts: (j.attempts || 0) + 1,
      note: `${choice.v.code} ${choice.v.type} · og‘irlik ${choice.v.checks.weight.util}% · hajm ${choice.v.checks.volume.util}%` });
    db.run("UPDATE ai_events SET status='RESOLVED', resolved_at=? WHERE dedupe_key=? AND status<>'RESOLVED'", now, `dispatch-${orderId}`);
    db.audit(actor, 'AI_DISPATCH_PLAN', 'dispatch_jobs', j.id, { order: o.order_no, shipment: sh.shipNo, vehicle: choice.v.code, driver: choice.d.full_name });
    db.emit('DISPATCH_PLANNED', { jobId: j.id, orderId, orderNo: o.order_no, shipmentId: sh.id, shipNo: sh.shipNo, telegram: !!choice.d.telegram_chat_id });
    return { jobId: j.id, status, shipNo: sh.shipNo, vehicle: choice.v.code, driver: choice.d.full_name };
  });
}

function decline(jobId, reason, user) {
  return db.tx(() => {
    const j = job(jobId); if (!ACTIVE.includes(j.status)) throw bad(`Topshiriq holati: ${j.status}`);
    const t = tried(j); if (j.vehicle_id) t.vehicles.push(j.vehicle_id); if (j.driver_id) t.drivers.push(j.driver_id);
    const actor = user || sys();
    if (j.shipment_id) { const s = db.get('SELECT status FROM shipments WHERE id=?', j.shipment_id); if (s && ['PLANNED', 'LOADING', 'LOADED'].includes(s.status)) db.withUser(actor, () => logi.cancelShipment(j.shipment_id, { reason: `AI dispetcher: ${reason}` }, actor)); }
    setJob(j.id, { status: 'REPLAN', tried: JSON.stringify(t), note: reason, shipment_id: null });
    db.emit('DISPATCH_DECLINED', { jobId: j.id, orderId: j.order_id, reason });
    return planOrder(j.order_id, actor);
  });
}
function driverAnswer(jobId, accept, chatId) {
  const j = job(jobId);
  const d = db.get('SELECT * FROM drivers WHERE id=?', j.driver_id);
  if (!d || String(d.telegram_chat_id) !== String(chatId)) throw bad('Bu topshiriq sizga tegishli emas');
  if (!accept) return decline(jobId, `Haydovchi ${d.full_name} rad etdi`);
  if (j.status !== 'CONTACTING' && j.status !== 'AWAIT_CONFIRM') throw bad(`Topshiriq holati: ${j.status}`);
  setJob(j.id, { status: 'DRIVER_ACCEPTED', note: `Haydovchi ${d.full_name} qabul qildi` });
  db.audit(sys(), 'AI_DISPATCH_DRIVER_ACCEPT', 'dispatch_jobs', j.id, { driver: d.full_name });
  db.emit('DISPATCH_DRIVER_ACCEPTED', { jobId: j.id, orderId: j.order_id, driver: d.full_name });
  return { status: 'DRIVER_ACCEPTED' };
}
/** Load (if not yet) and dispatch: the cargo leaves the warehouse (SHIP transactions). */
function dispatchJob(jobId, user) {
  return db.tx(() => {
    const j = job(jobId); if (!ACTIVE.includes(j.status)) throw bad(`Topshiriq holati: ${j.status}`);
    const actor = user || sys();
    return db.withUser(actor, () => {
      let lt = db.get('SELECT * FROM loading_tasks WHERE shipment_id=? ORDER BY id DESC', j.shipment_id);
      if (lt.status === 'PENDING') { logi.startLoading(lt.id, actor); lt = db.get('SELECT * FROM loading_tasks WHERE id=?', lt.id); }
      if (lt.status === 'IN_PROGRESS') logi.completeLoading(lt.id, { loadAll: true }, actor);
      const r = logi.dispatch(j.shipment_id, {}, actor);
      setJob(j.id, { status: 'DISPATCHED', note: `Jo‘natildi · ETA ${r.eta.slice(0, 16).replace('T', ' ')}` });
      db.audit(actor, 'AI_DISPATCH_DONE', 'dispatch_jobs', j.id, { shipmentId: j.shipment_id });
      db.emit('DISPATCH_DONE', { jobId: j.id, orderId: j.order_id, shipmentId: j.shipment_id, by: actor.fullName });
      return { status: 'DISPATCHED', eta: r.eta };
    });
  });
}
function cancel(jobId, user) {
  return db.tx(() => {
    const j = job(jobId);
    if (j.shipment_id) { const s = db.get('SELECT status FROM shipments WHERE id=?', j.shipment_id); if (s && ['PLANNED', 'LOADING', 'LOADED'].includes(s.status)) logi.cancelShipment(j.shipment_id, { reason: 'AI dispetcher topshirig‘i bekor qilindi' }, user); }
    setJob(j.id, { status: 'CANCELLED' }); db.audit(user, 'AI_DISPATCH_CANCEL', 'dispatch_jobs', j.id);
    return { status: 'CANCELLED' };
  });
}

/** One autopilot cycle. */
function cycle() {
  if (!require('./modules').logisticsOn()) return { mode: 'off', reason: 'Logistika moduli o‘chirilgan' };
  const s = settings(); if (s.mode === 'off') return { mode: 'off' };
  const out = { planned: 0, replanned: 0, dispatched: 0 };
  const orders = db.all(`SELECT o.id FROM orders o WHERE o.status='PACKED' AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id=o.id AND s.status IN ('PLANNED','LOADING','LOADED'))
    AND NOT EXISTS (SELECT 1 FROM dispatch_jobs j WHERE j.order_id=o.id AND j.status IN ('CONTACTING','AWAIT_CONFIRM','DRIVER_ACCEPTED'))
    AND NOT EXISTS (SELECT 1 FROM dispatch_jobs j WHERE j.order_id=o.id AND j.status='NO_TRANSPORT' AND j.updated_at>?) ORDER BY o.due_date`, new Date(Date.now() - 10 * 60000).toISOString());
  for (const o of orders) { try { const r = planOrder(o.id); if (r.shipNo) out.planned++; } catch (err) { console.error('dispatch plan', o.id, err.message); } }
  const cutoff = new Date(Date.now() - s.driverTimeoutMin * 60000).toISOString();
  for (const j of db.all("SELECT id FROM dispatch_jobs WHERE status='CONTACTING' AND contacted_at<?", cutoff)) { try { decline(j.id, `Haydovchi ${s.driverTimeoutMin} daqiqada javob bermadi`); out.replanned++; } catch (err) { console.error('dispatch timeout', err.message); } }
  if (s.mode === 'auto') for (const j of db.all("SELECT id FROM dispatch_jobs WHERE status='DRIVER_ACCEPTED' AND planned_at<=?", clock.iso())) { try { dispatchJob(j.id); out.dispatched++; } catch (err) { console.error('dispatch auto', err.message); } }
  return out;
}
function list() {
  return db.all(`SELECT j.*, o.order_no, o.destination, o.due_date, c.name customer, s.ship_no, s.status shipment_status, s.total_qty, s.pallet_count, s.total_weight_kg,
      v.code vehicle, v.type vehicle_type, v.plate, d.full_name driver, d.phone driver_phone, d.telegram_chat_id IS NOT NULL driver_telegram
    FROM dispatch_jobs j JOIN orders o ON o.id=j.order_id LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN shipments s ON s.id=j.shipment_id
    LEFT JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN drivers d ON d.id=j.driver_id ORDER BY j.id DESC LIMIT 300`);
}
let timer = null;
function start() { timer = setInterval(() => { try { cycle(); } catch (err) { console.error('dispatcher:', err.message); } }, Number(process.env.DISPATCH_CYCLE_SECONDS || 60) * 1000); timer.unref(); }

module.exports = { MODES, settings, saveSettings, planOrder, decline, driverAnswer, dispatchJob, cancel, cycle, list, start };
