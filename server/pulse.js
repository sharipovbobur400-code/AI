'use strict';
// Menyudagi doimiy “AI tahlil” paneli: sayt holatining qisqa, bazaga asoslangan tahlili (bo‘lim foydalanuvchisiga — faqat o‘z bo‘limi).
const db = require('./db');
const { clock } = require('./core');

const ALERT_TYPES = {
  OMBOR: ['LOW_STOCK', 'WAREHOUSE_CAPACITY', 'SPACE_OPTIMIZATION', 'CYCLE_COUNT', 'TASK_OVERDUE', 'QC_FAILED', 'RECEIVING_SHORT', 'ROOT_CAUSE', 'ORDER_RISK'],
  TAMINOT: ['DELIVERY_DELAY', 'SHORTAGE', 'LOW_STOCK'],
  LOGISTIKA: ['SHIPMENT_DELAY', 'SHIPMENT_RISK', 'ORDER_RISK', 'DISPATCH', 'ROOT_CAUSE'],
  ISHLAB: ['QC_FAILED', 'LOW_STOCK', 'ROOT_CAUSE', 'TASK_OVERDUE', 'ORDER_RISK'],
};
const val = (sql, ...p) => { try { return Number(db.val(sql, ...p) || 0); } catch { return 0; } };

function metrics(section) {
  const now = clock.iso(); const today = now.slice(0, 10);
  const odooLatePo = val('SELECT COUNT(*) FROM odoo_purchases WHERE is_late=1');
  const odooLateDel = val('SELECT COUNT(*) FROM odoo_deliveries WHERE is_late=1');
  const M = {
    lowStock: { label: 'Minimaldan past mahsulot', value: val("SELECT COUNT(*) FROM ai_events WHERE status='OPEN' AND type='LOW_STOCK'"), href: '/stock', bad: true },
    qcWaiting: { label: 'QC kutayotgan kirim', value: val("SELECT COUNT(*) FROM receiving_orders WHERE status='RECEIVING'"), href: '/receiving' },
    picking: { label: 'Ochiq picking', value: val("SELECT COUNT(*) FROM picking_tasks WHERE status IN ('PENDING','IN_PROGRESS')"), href: '/picking' },
    shortages: { label: 'Yetishmovchilik', value: val("SELECT COUNT(*) FROM shortages WHERE status IN ('OPEN','REQUESTED')"), href: '/shortages', bad: true },
    approvals: { label: 'Tasdiq kutayotgan zayavka', value: val("SELECT COUNT(*) FROM purchase_requests WHERE status='REQUESTED'"), href: '/purchase' },
    supplierLate: { label: 'Kechikkan yetkazib berish', value: val("SELECT COUNT(*) FROM supplier_deliveries WHERE status IN ('CONFIRMED','IN_TRANSIT') AND expected_date<?", now) + odooLatePo, href: odooLatePo ? '/odoo-purchases' : '/deliveries', bad: true },
    shipToday: { label: 'Bugungi jo‘natma', value: val("SELECT COUNT(*) FROM shipments WHERE status IN ('PLANNED','LOADING','LOADED') AND substr(planned_departure,1,10)<=?", today), href: '/shipments' },
    shipLate: { label: 'Kechikkan jo‘natma', value: val("SELECT COUNT(*) FROM shipments WHERE status='DISPATCHED' AND eta<?", now) + odooLateDel, href: odooLateDel ? '/odoo-deliveries' : '/shipments', bad: true },
    prodToday: { label: 'Bugun ishlab chiqarildi', value: val("SELECT COALESCE(SUM(qty_received),0) FROM receiving_orders WHERE source='PRODUCTION' AND created_at>=?", require('./teambots-data').dayStartIso()), href: '/production' },
    prodOpen: { label: 'Ochiq ishlab chiqarish', value: val("SELECT COUNT(*) FROM production_orders WHERE status IN ('PLANNED','RELEASED','IN_PROGRESS')"), href: '/production-orders' },
    prodShort: { label: 'Material yetishmaydi', value: (() => { try { return require('./production').mrp().filter((m) => m.status === 'SHORT').length; } catch { return 0; } })(), href: '/mrp', bad: true },
    freeVehicles: { label: 'Bo‘sh transport', value: val("SELECT COUNT(*) FROM vehicles WHERE status='AVAILABLE'"), href: '/transport' },
  };
  const keys = { OMBOR: ['lowStock', 'qcWaiting', 'picking'], TAMINOT: ['shortages', 'approvals', 'supplierLate'], LOGISTIKA: ['shipToday', 'shipLate', 'freeVehicles'], ISHLAB: ['prodToday', 'prodOpen', 'prodShort'] }[section]
    || ['shortages', 'supplierLate', 'prodShort', 'lowStock'];
  return keys.map((k) => ({ key: k, ...M[k] }));
}

function pulse(user) {
  const section = user?.section || null;
  const types = section ? ALERT_TYPES[section] : null;
  const where = types ? `AND type IN (${types.map(() => '?').join(',')})` : '';
  const alerts = db.all(`SELECT id, severity, title, message, type, created_at FROM ai_events WHERE status='OPEN' AND severity<>'INFO' ${where}
    ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 ELSE 1 END, id DESC LIMIT 4`, ...(types || []));
  const crit = val(`SELECT COUNT(*) FROM ai_events WHERE status='OPEN' AND severity='CRITICAL' ${where}`, ...(types || []));
  const warn = val(`SELECT COUNT(*) FROM ai_events WHERE status='OPEN' AND severity='WARNING' ${where}`, ...(types || []));
  const m = metrics(section);
  const badOnes = m.filter((x) => x.bad && x.value > 0);
  const headline = crit ? `🔴 ${crit} ta kritik holat — zudlik bilan ko‘ring` : warn ? `🟠 ${warn} ta ogohlantirish bor` : badOnes.length ? `🟡 ${badOnes.map((x) => `${x.label.toLowerCase()}: ${x.value}`).join(', ')}` : '🟢 Hammasi joyida — muammo aniqlanmadi';
  const odoo = db.setting('odoo', null);
  const lastScan = db.setting('last_ai_scan_at', null) || db.val("SELECT MAX(created_at) FROM system_events WHERE type='AI_SCAN'");
  return { at: clock.iso(), section, headline, level: crit ? 'crit' : warn || badOnes.length ? 'warn' : 'ok', metrics: m, alerts,
    odoo: odoo ? { lastSyncAt: odoo.lastSyncAt || null, status: odoo.lastStatus || null } : null, lastScan };
}
module.exports = { pulse, ALERT_TYPES };
