'use strict';
// Bo‘limlar (Ombor, Ta’minot, Logistika): bo‘limga biriktirilgan foydalanuvchi faqat o‘z bo‘limi sahifalari va API larini ishlata oladi.
// Cheklov serverda (har bir API so‘rov) va brauzerda (menyu, marshrutlar) bir xil ro‘yxat asosida ishlaydi.
const crypto = require('node:crypto');

// api: [yo‘l prefiksi, ruxsat etilgan metodlar ('*' — hammasi)]
const COMMON_API = [
  ['/api/meta', 'GET'], ['/api/sections', 'GET'], ['/api/client-errors', 'POST'], ['/api/odoo/status', 'GET'], ['/api/ai/pulse', 'GET'], ['/api/events/stream', 'GET'], ['/api/notifications', '*'], ['/api/tasks', 'GET'], ['/api/admin/filecheck', 'GET'],
  ['/api/bot/status', 'GET'], ['/api/bot/link-code', 'POST'], ['/api/bot/prefs/', 'PUT'], ['/api/bot/unlink/', 'POST'], ['/api/bot/test', 'POST'], ['/api/bot/preview', 'GET'],
  [/^\/api\/documents$/, 'POST'], [/^\/api\/documents\/generate$/, 'POST'], ['/api/documents/versions/', 'GET'], [/^\/api\/documents\/\d+$/, 'GET'], [/^\/api\/documents\/\d+\/versions$/, 'POST'],
];
const SECTIONS = {
  OMBOR: {
    label: 'Ombor', prefix: 'omb', roles: { STAFF: 'STOREKEEPER', HEAD: 'MANAGER' },
    pages: ['/dashboard', '/receiving', '/issue', '/products', '/stock', '/warehouses', '/reservations', '/transfer', '/counts', '/quality', '/qr', '/trace', '/transactions', '/picking', '/packing', '/tasks', '/telegram'],
    api: [['/api/warehouses', '*'], ['/api/zones', '*'], ['/api/locations', '*'], ['/api/products', '*'], ['/api/inventory', '*'], ['/api/receiving', '*'],
      ['/api/picking', '*'], ['/api/packing', '*'], ['/api/pallets', '*'], ['/api/qr/', 'GET'], ['/api/trace/serial/', 'GET'], ['/api/trace/pallet/', 'GET'],
      ['/api/reports/traceability', 'GET'], ['/api/dashboard/warehouse', 'GET'], ['/api/orders', 'GET'], ['/api/ai/insights', 'GET'], ['/api/tasks/suggest', 'GET'], ['/api/loading', '*']],
    events: ['STOCK_', 'MATERIAL_', 'QC_', 'PICKING_', 'PACKING_', 'TASK_', 'PRODUCT_', 'ORDER_', 'LOADING_'],
  },
  TAMINOT: {
    label: 'Ta’minot', prefix: 'tam', roles: { STAFF: 'PROCUREMENT', HEAD: 'MANAGER' },
    pages: ['/shortages', '/purchase', '/odoo-purchases', '/suppliers', '/deliveries', '/products', '/tasks', '/telegram'],
    api: [['/api/purchase-requests', '*'], ['/api/suppliers', '*'], ['/api/supplier-deliveries', '*'], ['/api/shortages', '*'], ['/api/products', 'GET'],
      ['/api/warehouses', 'GET'], ['/api/inventory', 'GET'], ['/api/orders', 'GET'], ['/api/ai/scan', 'POST'], ['/api/odoo/purchases', 'GET']],
    events: ['SHORTAGE_', 'SUPPLIER_', 'PURCHASE_', 'DELIVERY_', 'MATERIAL_RECEIVED', 'PRODUCT_', 'TASK_'],
  },
  ISHLAB: {
    label: 'Ishlab chiqarish', prefix: 'ish', roles: { STAFF: 'PRODUCTION', HEAD: 'MANAGER' },
    pages: ['/production', '/production-orders', '/bom', '/mrp', '/receiving', '/products', '/quality', '/tasks', '/telegram'],
    api: [['/api/production', '*'], ['/api/products', 'GET'], ['/api/inventory', 'GET'], ['/api/receiving', 'GET'], ['/api/receiving/production', 'POST'], ['/api/orders', 'GET'],
      ['/api/warehouses', 'GET'], ['/api/locations', 'GET'], ['/api/documents', 'POST'], ['/api/tasks/suggest', 'GET']],
    events: ['PRODUCTION_', 'MATERIAL_RECEIVED', 'QC_', 'ORDER_', 'TASK_', 'STOCK_CHANGED'],
  },
  LOGISTIKA: { // eski bo‘lim: mavjud loginlar ishlashda davom etadi, yangisi yaratilmaydi
    hidden: true, label: 'Logistika', prefix: 'log', roles: { STAFF: 'LOGISTICS', HEAD: 'MANAGER' },
    pages: ['/orders', '/odoo-deliveries', '/transport', '/shipments', '/loading', '/drivers', '/dispatch', '/tasks', '/telegram'],
    api: [['/api/vehicles', '*'], ['/api/drivers', '*'], ['/api/transport', '*'], ['/api/shipments', '*'], ['/api/loading', '*'], ['/api/dispatch', '*'],
      ['/api/orders', '*'], ['/api/trace/shipment/', 'GET'], ['/api/pallets', 'GET'], ['/api/dashboard/warehouse', 'GET'], ['/api/daily-reports/preview/', 'GET'],
      ['/api/products', 'GET'], ['/api/projects', 'GET'], ['/api/tasks/suggest', 'GET'], ['/api/odoo/deliveries', 'GET']],
    events: ['SHIPMENT_', 'LOADING_', 'VEHICLE_', 'DISPATCH_', 'ORDER_', 'PACKING_COMPLETED', 'TASK_', 'BOT_LINKED'],
  },
};
const LEVELS = { STAFF: 'Xodim', HEAD: 'Bo‘lim boshlig‘i' };

const hit = (rules, method, pathname) => rules.some(([p, m]) => (m === '*' || m === method) && (p instanceof RegExp ? p.test(pathname) : pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`) || pathname === p.replace(/\/$/, '')));

/** Bo‘lim foydalanuvchisi uchun API so‘rov ruxsat etilganmi. */
function allows(section, method, pathname) {
  const s = SECTIONS[section]; if (!s) return false;
  const m = method === 'HEAD' ? 'GET' : method;
  return hit(COMMON_API, m, pathname) || hit(s.api, m, pathname);
}
function eventAllowed(section, type) { const s = SECTIONS[section]; return !s || s.events.some((e) => type.startsWith(e)); }

/** Login: bo‘lim kodi + 4 raqam (masalan omb-4821). Parol: o‘qish oson, 12 belgi. */
function generateCredentials(section, exists) {
  const s = SECTIONS[section];
  let login;
  for (let i = 0; i < 50; i++) { login = `${s.prefix}-${crypto.randomInt(1000, 10000)}`; if (!exists(login)) break; login = null; }
  if (!login) login = `${s.prefix}-${crypto.randomBytes(3).toString('hex')}`;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let password = '';
  while (!(/[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password))) password = Array.from({ length: 12 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return { login, password };
}
function publicList() { return Object.fromEntries(Object.entries(SECTIONS).map(([k, v]) => [k, { label: v.label, prefix: v.prefix, pages: v.pages, hidden: !!v.hidden }])); }

module.exports = { SECTIONS, LEVELS, allows, eventAllowed, generateCredentials, publicList };
