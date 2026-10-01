'use strict';
// Initial master data + (demo mode) ~3 weeks of operating history generated THROUGH the real services,
// so every number on the dashboards is backed by inventory transactions.
const db = require('./db');
const auth = require('./auth');
const inv = require('./inventory');
const orders = require('./orders');
const proc = require('./procurement');
const logi = require('./logistics');
const docs = require('./documents');
const xetq = require('./xetq');
const { clock } = require('./core');

function master(demo) {
  const now = clock.iso();
  db.setSetting('company_name', 'SOLAR FACTORY — Quyosh panellari zavodi');
  db.setSetting('company_address', 'Toshkent viloyati, Chirchiq sanoat zonasi');
  for (const [k, v] of Object.entries({ qc_deadline_hours: 4, pick_deadline_hours: 4, pack_deadline_hours: 3, loading_setup_min: 15, loading_min_per_pallet: 4, avg_speed_kmh: 55 })) db.setSetting(k, v);

  if (demo) {
  const pw = process.env.SEED_PASSWORD || 'Solar2026!';
  const hash = auth.hashPassword(pw);
  const users = [['direktor', 'Rustam Aliyev', 'DIRECTOR'], ['admin', 'Tizim administratori', 'ADMIN'], ['menejer', 'Dilnoza Karimova', 'MANAGER'], ['omborchi1', 'Sherzod Rahimov', 'STOREKEEPER'],
    ['omborchi2', 'Aziz Qodirov', 'STOREKEEPER'], ['omborchi3', 'Jamshid Ergashev', 'STOREKEEPER'], ['qc', 'Nodira Usmonova', 'QC'], ['logist', 'Bobur Xolmatov', 'LOGISTICS'],
    ['taminot', 'Malika Saidova', 'PROCUREMENT'], ['kuzatuvchi', 'Kuzatuvchi', 'VIEWER']];
  for (const [u, n, r] of users) {
    const eid = db.insert('employees', { full_name: n, position: auth.ROLES[r][0], department: 'Ombor va logistika', hired_at: '2024-01-15' });
    db.insert('users', { username: u, password_hash: hash, full_name: n, role_code: r, employee_id: eid, active: 1, created_at: now });
  }
  }

  const WH = [
    ['WH-01', 'Xomashyo ombori', 'RAW', 60, 36, 10, 12000, 1400000, [['RCV', 'Qabul zonasi', 'RECEIVING', 'D', 4, 3], ['QC', 'QC zonasi', 'QC', 'Q', 2, 3], ['A', 'Xomashyo A', 'RAW', 'R', [6, 3, 4], 1], ['B', 'Xomashyo B', 'RAW', 'R', [4, 3, 4], 1]]],
    ['WH-02', 'Ishlab chiqarish ombori (WIP)', 'WIP', 40, 24, 8, 4600, 400000, [['A', 'WIP A', 'WIP', 'R', [4, 2, 3], 1]]],
    ['WH-03', 'Tayyor mahsulot ombori', 'FINISHED', 72, 40, 11, 18000, 2400000, [['RCV', 'Qabul zonasi', 'RECEIVING', 'D', 4, 4], ['QC', 'QC zonasi', 'QC', 'Q', 2, 4], ['A', 'Tayyor mahsulot A', 'FINISHED', 'R', [7, 3, 4], 1], ['B', 'Tayyor mahsulot B', 'FINISHED', 'R', [5, 3, 4], 1], ['PK', 'Qadoqlash zonasi', 'PACKING', 'K', 3, 10], ['RT', 'Qaytarilgan mahsulot', 'RETURN', 'T', 2, 4]]],
    ['WH-04', 'Qadoq materiallari ombori', 'PACKAGING', 30, 20, 7, 2500, 150000, [['A', 'Qadoq materiallari', 'RAW', 'R', [4, 3, 3], 1]]],
    ['WH-05', 'Brak va rework ombori', 'SCRAP', 24, 18, 7, 1800, 200000, [['RW', 'Rework zonasi', 'REWORK', 'W', 4, 4], ['SC', 'Brak (Scrap) zonasi', 'SCRAP', 'S', 8, 6]]],
    ['WH-06', 'Jo‘natish ombori (Dispatch)', 'DISPATCH', 40, 30, 8, 5000, 900000, [['DZ', 'Jo‘natish zonasi', 'DISPATCH', 'L', 10, 8]]],
  ];
  for (const [id, name, type, L, W, H, vol, maxLoad, zones] of WH) {
    db.insert('warehouses', { id, name, type, address: 'Chirchiq sanoat zonasi', length_m: L, width_m: W, height_m: H, usable_volume_m3: vol, pallet_positions: 0, max_load_kg: maxLoad, active: 1 });
    zones.forEach(([code, zname, ztype, prefix, spec, maxP], zi) => {
      const zid = `${id}-${code}`;
      db.insert('warehouse_zones', { id: zid, warehouse_id: id, code, name: zname, zone_type: ztype, sort: zi + 1 });
      const wc = id.replace('-', '');
      if (Array.isArray(spec)) {
        const [racks, shelves, pos] = spec;
        for (let r = 1; r <= racks; r++) for (let s = 1; s <= shelves; s++) for (let p = 1; p <= pos; p++)
          db.insert('warehouse_locations', { code: `${wc}-${code}-R${String(r).padStart(2, '0')}-S${String(s).padStart(2, '0')}-P${String(p).padStart(2, '0')}`, warehouse_id: id, zone_id: zid, rack: `R${String(r).padStart(2, '0')}`, shelf: `S${String(s).padStart(2, '0')}`, position: `P${String(p).padStart(2, '0')}`, max_pallets: maxP, max_weight_kg: 1500, x: r * 3, y: (zi + 1) * 12 + p });
      } else {
        for (let i = 1; i <= spec; i++) db.insert('warehouse_locations', { code: `${wc}-${code}-${prefix}${String(i).padStart(2, '0')}`, warehouse_id: id, zone_id: zid, max_pallets: maxP, max_weight_kg: 12000, x: i * 2, y: (zi + 1) * 12 });
      }
      db.run('UPDATE warehouse_zones SET pallet_positions=(SELECT SUM(max_pallets) FROM warehouse_locations WHERE zone_id=?) WHERE id=?', zid, zid);
    });
    db.run(`UPDATE warehouses SET pallet_positions=(SELECT SUM(l.max_pallets) FROM warehouse_locations l JOIN warehouse_zones z ON z.id=l.zone_id WHERE l.warehouse_id=? AND z.zone_type IN ('RAW','WIP','FINISHED','REWORK','SCRAP','DISPATCH')) WHERE id=?`, id, id);
  }

  if (!demo) return; // real mode: suppliers, products, transport and customers come from the company (UI / API integration)
  const SUP = [
    ['SUP-000', 'SF Ishlab chiqarish sexi (ichki)', 'Ishlab chiqarish rejalashtirish bo‘limi', '+998 71 200 10 00', 'production@solarfactory.local', 'Chirchiq, 1-sex', 'O‘zbekiston', 'Ichki', 'INT-2026'],
    ['SUP-001', 'SunCell Components Co.', 'Li Wei', '+86 512 6000 1234', 'sales@suncell-components.example', 'Suzhou, Jiangsu', 'Xitoy', '30% oldindan, 70% yetkazilganda', 'SC-2026/014'],
    ['SUP-002', 'Polymer Film Trade LLC', 'Emre Kaya', '+90 212 555 0101', 'export@polymerfilm.example', 'Istanbul', 'Turkiya', '45 kun', 'PF-2026/07'],
    ['SUP-003', 'Samarqand Shisha Zavodi', 'Anvar Toirov', '+998 66 233 44 55', 'savdo@samshisha.example', 'Samarqand', 'O‘zbekiston', '14 kun', 'SSZ-118'],
    ['SUP-004', 'AlumProfile Group', 'Yerlan Suleimenov', '+7 727 300 4040', 'order@alumprofile.example', 'Almaty', 'Qozog‘iston', '30 kun', 'AP-2026-22'],
    ['SUP-005', 'JBox Electric Ltd.', 'Zhang Min', '+86 574 8800 2020', 'info@jboxelectric.example', 'Ningbo', 'Xitoy', '100% oldindan', 'JB-2026-05'],
    ['SUP-006', 'Toshkent Qadoq Servis', 'Gulnora Mirzayeva', '+998 71 150 22 33', 'buyurtma@tqs.example', 'Toshkent', 'O‘zbekiston', '7 kun', 'TQS-2026-3'],
    ['SUP-007', 'ChemSeal Industries', 'Murat Demir', '+90 232 444 9090', 'sales@chemseal.example', 'Izmir', 'Turkiya', '30 kun', 'CS-2026-11'],
  ];
  for (const [code, company, contact, phone, email, address, country, payment_terms, contract_no] of SUP) db.insert('suppliers', { code, company, contact, phone, email, address, country, payment_terms, contract_no, contract_until: '2027-12-31', active: 1, created_at: now });
  const sid = (c) => db.val('SELECT id FROM suppliers WHERE code=?', c);

  const P = [
    { sku: 'SP-550W-M', name: 'Quyosh paneli 550W Mono PERC', model: 'SF-M550-144HC', category: 'FINISHED', power_w: 550, length_mm: 2279, width_mm: 1134, height_mm: 35, net_weight_kg: 28.6, gross_weight_kg: 29.8, units_per_pallet: 31, pallet_weight_kg: 25, pallet_length_mm: 2300, pallet_width_mm: 1150, pallet_height_mm: 1260, packaging_type: 'Karton + yog‘och pallet', packaging_weight_kg: 18, barcode: '4780001005501', track_serial: 1, min_stock: 300, max_stack: 2, orientation: 'VERTICAL', packing_standard: 'PS-SF-001 v2.1 (31 dona, vertikal, burchak himoyasi)', electrical_spec: 'Pmax 550W, Voc 49.9V, Isc 14.0A, Vmp 41.9V, Imp 13.13A, η 21.3%', supplier: 'SUP-000', lead: 3 },
    { sku: 'SP-450W-M', name: 'Quyosh paneli 450W Mono PERC', model: 'SF-M450-144HC', category: 'FINISHED', power_w: 450, length_mm: 2094, width_mm: 1038, height_mm: 35, net_weight_kg: 23.5, gross_weight_kg: 24.6, units_per_pallet: 31, pallet_weight_kg: 23, pallet_length_mm: 2110, pallet_width_mm: 1120, pallet_height_mm: 1180, packaging_type: 'Karton + yog‘och pallet', packaging_weight_kg: 16, barcode: '4780001004501', track_serial: 1, min_stock: 150, max_stack: 2, orientation: 'VERTICAL', packing_standard: 'PS-SF-001 v2.1', electrical_spec: 'Pmax 450W, Voc 49.6V, Isc 11.6A, η 20.7%', supplier: 'SUP-000', lead: 3 },
    { sku: 'SP-600W-BF', name: 'Quyosh paneli 600W Bifacial (shisha-shisha)', model: 'SF-BF600-132', category: 'FINISHED', power_w: 600, length_mm: 2172, width_mm: 1303, height_mm: 33, net_weight_kg: 32.5, gross_weight_kg: 33.9, units_per_pallet: 31, pallet_weight_kg: 28, pallet_length_mm: 2200, pallet_width_mm: 1330, pallet_height_mm: 1250, packaging_type: 'Kuchaytirilgan karton', packaging_weight_kg: 24, barcode: '4780001006001', track_serial: 1, min_stock: 100, max_stack: 1, fragile: 1, orientation: 'VERTICAL', packing_standard: 'PS-SF-004 v1.0 (shisha-shisha, stack taqiqlanadi)', electrical_spec: 'Pmax 600W, bifaciality 70%, η 21.2%', supplier: 'SUP-000', lead: 4 },
    { sku: 'SP-410W-BL', name: 'Quyosh paneli 410W Full Black', model: 'SF-FB410-108', category: 'FINISHED', power_w: 410, length_mm: 1722, width_mm: 1134, height_mm: 30, net_weight_kg: 21.5, gross_weight_kg: 22.4, units_per_pallet: 36, pallet_weight_kg: 22, pallet_length_mm: 1760, pallet_width_mm: 1150, pallet_height_mm: 1210, packaging_type: 'Karton + yog‘och pallet', packaging_weight_kg: 15, barcode: '4780001004101', track_serial: 1, min_stock: 72, max_stack: 2, orientation: 'HORIZONTAL', packing_standard: 'PS-SF-002 v1.3 (36 dona, gorizontal)', supplier: 'SUP-000', lead: 3 },
    { sku: 'WIP-LAM-550', name: 'Laminat 550W (ramkasiz)', category: 'WIP', length_mm: 2270, width_mm: 1128, height_mm: 5, net_weight_kg: 24, gross_weight_kg: 24, units_per_pallet: 20, pallet_length_mm: 2300, pallet_width_mm: 1150, pallet_height_mm: 900, min_stock: 40, max_stack: 1, fragile: 1, supplier: 'SUP-000', lead: 1 },
    { sku: 'WIP-STR-144', name: 'Hujayra stringi (144 hujayra)', category: 'WIP', net_weight_kg: 0.9, gross_weight_kg: 0.9, units_per_pallet: 300, min_stock: 100, supplier: 'SUP-000', lead: 1 },
    { sku: 'RM-CELL-M10', name: 'Quyosh hujayrasi M10 182mm PERC', category: 'RAW', length_mm: 182, width_mm: 182, height_mm: 0.2, net_weight_kg: 0.0075, gross_weight_kg: 0.009, units_per_pallet: 28800, pallet_height_mm: 1100, min_stock: 60000, supplier: 'SUP-001', lead: 21 },
    { sku: 'RM-GLASS-32', name: 'Temperlangan shisha 3.2mm AR', category: 'RAW', length_mm: 2272, width_mm: 1128, height_mm: 3.2, net_weight_kg: 20.5, gross_weight_kg: 21, units_per_pallet: 40, pallet_length_mm: 2300, pallet_width_mm: 1150, pallet_height_mm: 400, min_stock: 600, fragile: 1, supplier: 'SUP-003', lead: 5 },
    { sku: 'RM-EVA-045', name: 'EVA plyonka 0.45mm', category: 'MATERIAL', unit: 'm²', net_weight_kg: 0.42, gross_weight_kg: 0.45, units_per_pallet: 1500, min_stock: 5000, supplier: 'SUP-002', lead: 10 },
    { sku: 'RM-BS-TPT', name: 'Backsheet TPT oq', category: 'MATERIAL', unit: 'm²', net_weight_kg: 0.35, gross_weight_kg: 0.38, units_per_pallet: 2000, min_stock: 2500, supplier: 'SUP-002', lead: 10 },
    { sku: 'RM-FRAME-AL', name: 'Alyuminiy ramka to‘plami 35mm', category: 'MATERIAL', unit: 'to‘plam', net_weight_kg: 3.1, gross_weight_kg: 3.3, units_per_pallet: 300, min_stock: 500, supplier: 'SUP-004', lead: 12 },
    { sku: 'RM-JBOX-3D', name: 'Junction box IP68 (3 diod)', category: 'MATERIAL', net_weight_kg: 0.28, gross_weight_kg: 0.3, units_per_pallet: 1500, min_stock: 1000, supplier: 'SUP-005', lead: 18 },
    { sku: 'RM-RIBBON', name: 'Ribbon (bus-bar lenta)', category: 'MATERIAL', unit: 'kg', net_weight_kg: 1, gross_weight_kg: 1.05, units_per_pallet: 500, min_stock: 150, supplier: 'SUP-005', lead: 18 },
    { sku: 'RM-SIL-01', name: 'Silikon germetik', category: 'MATERIAL', unit: 'kg', net_weight_kg: 1, gross_weight_kg: 1.1, units_per_pallet: 400, min_stock: 200, supplier: 'SUP-007', lead: 9 },
    { sku: 'PK-CARTON', name: 'Karton qadoq to‘plami (pallet uchun)', category: 'PACKAGING', net_weight_kg: 9, gross_weight_kg: 9, units_per_pallet: 60, min_stock: 40, supplier: 'SUP-006', lead: 3 },
    { sku: 'PK-PALLET', name: 'Yog‘och pallet 2300×1150', category: 'PACKAGING', net_weight_kg: 25, gross_weight_kg: 25, units_per_pallet: 15, min_stock: 40, supplier: 'SUP-006', lead: 3 },
    { sku: 'PK-CORNER', name: 'Burchak himoyasi', category: 'PACKAGING', net_weight_kg: 0.05, gross_weight_kg: 0.05, units_per_pallet: 2000, min_stock: 400, supplier: 'SUP-006', lead: 3 },
    { sku: 'PK-FILM', name: 'Strech plyonka rulon', category: 'PACKAGING', net_weight_kg: 2.4, gross_weight_kg: 2.4, units_per_pallet: 60, min_stock: 20, supplier: 'SUP-006', lead: 3 },
  ];
  for (const p of P) {
    const { supplier, lead, ...row } = p;
    const vol = row.length_mm && row.width_mm && row.height_mm ? +(row.length_mm * row.width_mm * row.height_mm / 1e9).toFixed(4) : 0;
    const pid = db.insert('products', { unit: 'dona', manufacturer: row.category === 'FINISHED' || row.category === 'WIP' ? 'Solar Factory' : null, pallet_weight_kg: 25, pallet_length_mm: 1200, pallet_width_mm: 1000, pallet_height_mm: 1200, max_stack: 1, ...row, volume_m3: vol, default_supplier_id: sid(supplier), lead_time_days: lead, status: 'ACTIVE', created_at: now, updated_at: now });
    db.insert('supplier_products', { supplier_id: sid(supplier), product_id: pid, price: { FINISHED: 0, WIP: 0, RAW: 0.9, MATERIAL: 2.1, PACKAGING: 4 }[row.category] * (row.net_weight_kg > 5 ? 8 : 1), currency: 'USD', lead_time_days: lead, moq: 1 });
  }
  // alternative suppliers (for AI supplier choice)
  db.insert('supplier_products', { supplier_id: sid('SUP-007'), product_id: db.val("SELECT id FROM products WHERE sku='RM-EVA-045'"), price: 2.3, currency: 'USD', lead_time_days: 12, moq: 500 });
  db.insert('supplier_products', { supplier_id: sid('SUP-001'), product_id: db.val("SELECT id FROM products WHERE sku='RM-JBOX-3D'"), price: 2.0, currency: 'USD', lead_time_days: 25, moq: 1000 });

  const DRV = [['Jasur Abdullayev', '+998 90 111 22 33', 'AA1234567', 'CE'], ['Sardor Karimov', '+998 91 222 33 44', 'AB2345678', 'CE'], ['Bekzod Rashidov', '+998 93 333 44 55', 'AC3456789', 'C'],
    ['Alisher Tursunov', '+998 94 444 55 66', 'AD4567890', 'CE'], ['Dilshod Yusupov', '+998 97 555 66 77', 'AE5678901', 'C'], ['Otabek Nazarov', '+998 99 666 77 88', 'AF6789012', 'CE']];
  for (const [n, ph, lic, cat] of DRV) db.insert('drivers', { full_name: n, phone: ph, license_no: lic, license_category: cat, status: 'AVAILABLE', created_at: now });
  const VEH = [
    ['V-01', 'Furgon', 'Isuzu NPR 75', '01 A 123 BA', 4.3, 2.05, 2.1, 18.5, 3500, 8, 1],
    ['V-02', 'Tentli yuk mashinasi', 'Isuzu NQR 90 (tent)', '01 B 456 CA', 6.2, 2.45, 2.4, 36, 5500, 15, 2],
    ['V-03', 'Bortli', 'KAMAZ 65117 (bort)', '01 C 789 DA', 7.8, 2.45, 2.5, 47, 14000, 18, 3],
    ['V-04', 'Katta yuk mashinasi', 'MAN TGS 26.400 (10 m)', '01 D 321 EA', 9.6, 2.45, 2.7, 63, 15000, 24, 4],
    ['V-05', 'Yarim tirkama', 'Schmitz Cargobull 13.6 m', '01 E 654 FA', 13.6, 2.45, 2.7, 90, 22000, 33, 5],
    ['V-06', 'Konteyner tashuvchi', '40ft High Cube', '01 F 987 GA', 12.03, 2.35, 2.69, 76, 26500, 24, 6],
    ['V-07', 'Konteyner tashuvchi', '20ft Standard', '01 G 147 HA', 5.9, 2.35, 2.39, 33, 21700, 11, null],
    ['V-08', 'Tentli yuk mashinasi', 'Hyundai HD120 (tent)', '01 H 258 JA', 7.2, 2.4, 2.4, 41, 8000, 18, null],
  ];
  for (const [code, type, model, plate, L, W, H, vol, pay, pc, drv] of VEH) db.insert('vehicles', { code, type, model, plate, length_m: L, width_m: W, height_m: H, volume_m3: vol, payload_kg: pay, pallet_capacity: pc, owner: code === 'V-06' || code === 'V-07' ? 'Ijara: TransLogistic MChJ' : 'Solar Factory', driver_id: drv, status: 'AVAILABLE', created_at: now });

  const CUS = ['Navoiy Quyosh Energiya MChJ', 'Samarqand Green Power', 'Toshkent Solar Invest', 'Buxoro Agro Klaster', 'Farg‘ona Energo Servis', 'Qashqadaryo Solar Park'];
  for (const c of CUS) db.insert('customers', { name: c, created_at: now });
}

const U = (name) => { const u = db.get('SELECT id, username, role_code FROM users WHERE username=?', name); return { id: u.id, username: u.username, role: u.role_code }; };
const pid = (sku) => db.val('SELECT id FROM products WHERE sku=?', sku);
const cid = (n) => db.val('SELECT id FROM customers WHERE name=?', n);

function demoHistory() {
  const mgr = U('menejer'); const sk = [U('omborchi1'), U('omborchi2'), U('omborchi3')]; const qc = U('qc'); const lg = U('logist'); const pr = U('taminot'); const dir = U('direktor');
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const at = (day, h, m = 0) => clock.set(new Date(today.getTime() + day * 86400000 + (h * 60 + m) * 60000));
  let rnd = 42; const rand = () => { rnd = (rnd * 16807) % 2147483647; return (rnd - 1) / 2147483646; }; const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
  // same-day events are placed in the last few hours relative to the real clock (07:00 → 260 min ago … 11:00 → 20 min ago)
  const at0 = (h, m = 0) => clock.set(new Date(Date.now() - (260 - ((h - 7) * 60 + m)) * 60000));

  // projects
  at(-30, 9);
  const pNav = xetq.createProject({ code: 'PRJ-NAV-100', name: 'Navoiy 100 MW FES', customerId: cid('Navoiy Quyosh Energiya MChJ'), capacityMw: 100, location: 'Navoiy viloyati, Karmana', requiresXetq: false, startDate: '2026-06-01' }, mgr).id;
  const pSam = xetq.createProject({ code: 'PRJ-SAM-50', name: 'Samarqand 50 MW FES', customerId: cid('Samarqand Green Power'), capacityMw: 50, location: 'Samarqand viloyati', requiresXetq: true, startDate: '2026-07-15' }, mgr).id;
  const pTsh = xetq.createProject({ code: 'PRJ-TSH-ROOF', name: 'Tijorat tomlari 5 MW', customerId: cid('Toshkent Solar Invest'), capacityMw: 5, location: 'Toshkent shahri', requiresXetq: false }, mgr).id;

  // opening balances (raw materials & packaging) — initial stock take
  at(-26, 8);
  const opening = { 'RM-CELL-M10': 560000, 'RM-GLASS-32': 3900, 'RM-EVA-045': 24000, 'RM-BS-TPT': 12500, 'RM-FRAME-AL': 4200, 'RM-JBOX-3D': 5200, 'RM-RIBBON': 900, 'RM-SIL-01': 800, 'PK-CARTON': 260, 'PK-PALLET': 260, 'PK-CORNER': 4000, 'PK-FILM': 70, 'WIP-LAM-550': 60, 'WIP-STR-144': 400 };
  for (const [sku, q] of Object.entries(opening)) {
    const r = inv.receive({ source: 'OTHER', productId: pid(sku), qty: q, notes: 'Boshlang‘ich qoldiq (inventarizatsiya)', batchNo: `OPEN-${sku}` }, mgr);
    inv.qualityCheck(r.id, { passed: q }, qc);
  }

  const panelMix = [['SP-550W-M', 1, [95, 140]], ['SP-450W-M', 3, [60, 90]], ['SP-600W-BF', 4, [40, 62]], ['SP-410W-BL', 5, [36, 72]]];
  const custRot = ['Samarqand Green Power', 'Toshkent Solar Invest', 'Buxoro Agro Klaster', 'Farg‘ona Energo Servis', 'Qashqadaryo Solar Park', 'Navoiy Quyosh Energiya MChJ'];
  const dest = { 'Samarqand Green Power': 'Samarqand, FES qurilish maydoni', 'Toshkent Solar Invest': 'Toshkent, Sergeli tumani', 'Buxoro Agro Klaster': 'Buxoro, G‘ijduvon', 'Farg‘ona Energo Servis': 'Farg‘ona sh.', 'Qashqadaryo Solar Park': 'Qarshi', 'Navoiy Quyosh Energiya MChJ': 'Navoiy, Karmana FES' };
  const km = { 'Samarqand, FES qurilish maydoni': 300, 'Toshkent, Sergeli tumani': 45, 'Buxoro, G‘ijduvon': 540, 'Farg‘ona sh.': 320, Qarshi: 470, 'Navoiy, Karmana FES': 450 };
  const matPerPanel = { 'RM-CELL-M10': 144, 'RM-GLASS-32': 1, 'RM-EVA-045': 5.2, 'RM-BS-TPT': 2.6, 'RM-FRAME-AL': 1, 'RM-JBOX-3D': 1, 'RM-RIBBON': 0.12, 'RM-SIL-01': 0.08 };
  const procSku = [['RM-GLASS-32', 'SUP-003', 900], ['RM-EVA-045', 'SUP-002', 6000], ['RM-FRAME-AL', 'SUP-004', 900], ['RM-JBOX-3D', 'SUP-005', 1500], ['RM-CELL-M10', 'SUP-001', 100000], ['RM-BS-TPT', 'SUP-002', 3000], ['RM-SIL-01', 'SUP-007', 300], ['PK-PALLET', 'SUP-006', 60], ['PK-CARTON', 'SUP-006', 60]];
  let custI = 0; let procI = 0; let orderSeq = 0;

  const fulfil = (orderId, day, lateLoad) => {
    at(day, 8, 10);
    const t = orders.createPickTask(orderId, { assignedTo: sk[orderSeq % 3].id }, mgr);
    at(day, 8, 20); orders.startPick(t.id, sk[orderSeq % 3]);
    const lines = db.all('SELECT * FROM picking_task_lines WHERE task_id=? ORDER BY seq', t.id);
    let mm = 25;
    for (const l of lines) {
      if (rand() < 0.15) orders.scanPick(t.id, { code: 'SP-999-XX', lineId: l.id }, sk[orderSeq % 3]);
      orders.scanPick(t.id, { code: inv.location(l.location_id).code, lineId: l.id }, sk[orderSeq % 3]);
      at(day, 8, mm); mm += ri(4, 9);
      orders.pickLine(l.id, {}, sk[orderSeq % 3]);
    }
    at(day, 9, 40);
    const pal = orders.createPallets({ orderId }, sk[(orderSeq + 1) % 3]);
    at(day, 10, 5);
    const skipMove = lateLoad ? Math.ceil(pal.pallets.length / 2) : 0;
    pal.pallets.slice(skipMove).forEach((p) => orders.movePalletToDispatch(p.id, {}, sk[(orderSeq + 1) % 3]));
    at(day, 10, 30);
    const calc = logi.calculate({ orderId });
    const veh = calc.recommended || calc.vehicles.find((v) => v.fits && v.status === 'AVAILABLE');
    if (!veh) return null;
    const drv = db.val('SELECT driver_id FROM vehicles WHERE id=?', veh.vehicleId) || db.val("SELECT id FROM drivers WHERE status='AVAILABLE' LIMIT 1");
    const o = db.get('SELECT * FROM orders WHERE id=?', orderId);
    const sh = logi.createShipment({ orderId, vehicleId: veh.vehicleId, driverId: drv, destination: o.destination, distanceKm: km[o.destination] || 200, plannedDeparture: new Date(today.getTime() + day * 86400000 + 13 * 3600000).toISOString(), assignedTo: sk[(orderSeq + 2) % 3].id }, lg);
    at(day, lateLoad ? 12 : 11, lateLoad ? 10 : 0);
    const lt = db.get('SELECT * FROM loading_tasks WHERE shipment_id=?', sh.id);
    logi.startLoading(lt.id, sk[(orderSeq + 2) % 3]);
    const dur = lateLoad ? 118 : Math.round(lt.estimated_minutes * (0.8 + rand() * 0.5));
    clock.advance(dur * 60000);
    logi.completeLoading(lt.id, { loadAll: true }, sk[(orderSeq + 2) % 3]);
    return sh;
  };

  for (let day = -24; day <= -1; day++) {
    // production output → receiving → QC
    for (const [sku, every, [a, b]] of panelMix) {
      if ((day + 30) % every) continue;
      const total = ri(a, b); const rework = rand() < 0.5 ? ri(1, 3) : 0; const reject = rand() < 0.4 ? ri(1, 2) : 0;
      at(day, 7, 30);
      const r = inv.productionReceipt({ productId: pid(sku), total, good: total - rework - reject, rework, reject, productionOrder: `PRD-${sku.slice(3, 7)}-${String(day + 40).padStart(3, '0')}` }, sk[0]);
      at(day, 8, ri(5, 50));
      const fail = rand() < 0.2 ? ri(1, 2) : 0;
      if (r.receiving) inv.qualityCheck(r.receiving.id, { passed: r.good - fail, failed: fail, notes: fail ? 'Mikro-yoriq (EL test)' : '' }, qc);
      if (sku === 'SP-550W-M' || sku === 'SP-450W-M') {
        at(day, 7, 0);
        for (const [m, per] of Object.entries(matPerPanel)) { const q = Math.round(per * total * 100) / 100; if (inv.freeQty(pid(m)) >= q) inv.issue({ productId: pid(m), qty: q, reason: 'Ishlab chiqarishga berildi', reference: `PRD-${String(day + 40).padStart(3, '0')}` }, sk[1]); }
        for (const [m, q] of [['PK-CARTON', Math.ceil(total / 31)], ['PK-PALLET', Math.ceil(total / 31)], ['PK-CORNER', Math.ceil(total / 31) * 8]]) if (inv.freeQty(pid(m)) >= q) inv.issue({ productId: pid(m), qty: q, reason: 'Qadoqlashga', reference: 'PACK' }, sk[1]);
      }
    }
    // procurement cycle every 3 days
    if ((day + 30) % 3 === 0) {
      const [sku, sup, qty] = procSku[procI++ % procSku.length];
      at(day, 9, 15);
      const r = proc.create({ productId: pid(sku), qty, supplierId: db.val('SELECT id FROM suppliers WHERE code=?', sup), reason: 'Minimal zaxirani to‘ldirish', priority: 'NORMAL' }, pr);
      at(day, 10); proc.approve(r.id, {}, mgr);
      at(day, 11); proc.placeOrder(r.id, {}, pr);
      const lead = Math.min(6, Math.max(2, ri(2, 5)));
      at(day, 15); proc.supplierConfirm(r.id, { expectedDate: new Date(today.getTime() + (day + lead) * 86400000).toISOString() }, pr);
      const arriveDay = day + lead + (rand() < 0.3 ? ri(1, 2) : 0);
      if (arriveDay <= -1) {
        at(arriveDay - 1, 9); proc.inTransit(r.id, { vehicle: `${ri(10, 95)} ${String.fromCharCode(65 + ri(0, 20))} ${ri(100, 999)} AA`, driver: 'Yetkazib beruvchi haydovchisi' }, pr);
        at(arriveDay, 10, 30);
        const short = rand() < 0.25 ? Math.round(qty * 0.03) : 0;
        const a = proc.arrive(r.id, { qty: qty - short }, sk[2]);
        at(arriveDay, 12);
        const bad = rand() < 0.3 ? Math.max(1, Math.round((qty - short) * 0.01)) : 0;
        inv.qualityCheck(a.receiving.id, { passed: qty - short - bad, failed: bad, notes: bad ? 'Qadoq shikastlangan' : '' }, qc);
      }
    }
    // customer orders every 2 days, fulfilled next day
    if ((day + 30) % 2 === 0 && day <= -3) {
      const cust = custRot[custI++ % custRot.length];
      const sku = ['SP-550W-M', 'SP-550W-M', 'SP-450W-M', 'SP-600W-BF', 'SP-410W-BL'][ri(0, 4)];
      const per = db.val('SELECT units_per_pallet FROM products WHERE sku=?', sku);
      at(day, 14);
      const o = orders.createOrder({ customerId: cid(cust), projectId: cust === 'Samarqand Green Power' ? null : cust === 'Toshkent Solar Invest' ? pTsh : null, items: [{ productId: pid(sku), qty: per * ri(2, 6) }], dueDate: new Date(today.getTime() + (day + 2) * 86400000).toISOString(), destination: dest[cust], priority: 'NORMAL' }, mgr);
      if (o.status === 'RESERVED') {
        orderSeq++;
        const sh = fulfil(o.id, day + 1, orderSeq === 4);
        if (sh) {
          at(day + 1, 13, ri(0, 25)); logi.dispatch(sh.id, {}, lg);
          at(day + 1, 13 + Math.ceil((km[dest[cust]] || 200) / 55) + 1, ri(0, 50)); logi.arrive(sh.id, {}, lg);
        }
      }
    }
    if (day === -20) { at(day, 16); const c = inv.createCount({ warehouseId: 'WH-01', zoneId: 'WH-01-A' }, mgr); const lines = db.all('SELECT * FROM inventory_count_lines WHERE count_id=?', c.id); inv.recordCount(c.id, lines.map((l, i) => ({ id: l.id, physicalQty: i === 2 ? Math.max(0, l.system_qty - 13) : l.system_qty })), sk[0]); inv.postCount(c.id, { reason: 'Shisha partiyasida 13 dona siniq aniqlandi (akt №14)' }, mgr); }
    if (day === -9) { at(day, 11); inv.disposition({ productId: pid('SP-550W-M'), qty: 2, fromStatus: 'SCRAP', action: 'DISPOSE', reason: 'Utilizatsiya dalolatnomasi №7' }, qc); }
  }

  // ---------------- current state (today) ----------------
  at0(7, 30);
  const todayProd = inv.productionReceipt({ productId: pid('SP-550W-M'), total: 100, good: 96, rework: 2, reject: 2, productionOrder: 'PRD-550W-TODAY' }, sk[0]); // waits for QC
  at0(7, 45);
  const r450 = inv.productionReceipt({ productId: pid('SP-450W-M'), total: 64, good: 62, rework: 1, reject: 1, productionOrder: 'PRD-450W-TODAY' }, sk[0]);
  inv.qualityCheck(r450.receiving.id, { passed: 62 }, qc);

  // project reservation for Navoiy (soft allocation)
  at0(8);
  const free550 = inv.freeQty(pid('SP-550W-M'));
  if (free550 > 200) inv.reserve({ productId: pid('SP-550W-M'), qty: 124, projectId: pNav, note: 'Navoiy FES 1-bosqich uchun oldindan rezerv' }, mgr);

  // A) order packed, needs transport
  at(-1, 15);
  const oA = orders.createOrder({ customerId: cid('Toshkent Solar Invest'), projectId: pTsh, items: [{ productId: pid('SP-410W-BL'), qty: 72 }], dueDate: new Date(today.getTime() + 1 * 86400000).toISOString(), destination: dest['Toshkent Solar Invest'] }, mgr);
  if (oA.status === 'RESERVED') { at0(8, 30); const t = orders.createPickTask(oA.id, { assignedTo: sk[0].id }, mgr); for (const l of db.all('SELECT * FROM picking_task_lines WHERE task_id=?', t.id)) orders.pickLine(l.id, {}, sk[0]); at0(9, 15); const pl = orders.createPallets({ orderId: oA.id }, sk[0]); pl.pallets.forEach((p) => orders.movePalletToDispatch(p.id, {}, sk[0])); }

  // B) order with shipment currently LOADING
  at(-1, 16);
  const oB = orders.createOrder({ customerId: cid('Farg‘ona Energo Servis'), items: [{ productId: pid('SP-450W-M'), qty: 124 }], dueDate: new Date(today.getTime()).toISOString(), destination: dest['Farg‘ona Energo Servis'] }, mgr);
  if (oB.status === 'RESERVED') {
    at0(8, 40); const t = orders.createPickTask(oB.id, { assignedTo: sk[1].id }, mgr); for (const l of db.all('SELECT * FROM picking_task_lines WHERE task_id=?', t.id)) orders.pickLine(l.id, {}, sk[1]);
    at0(9, 30); const pl = orders.createPallets({ orderId: oB.id }, sk[1]); pl.pallets.forEach((p) => orders.movePalletToDispatch(p.id, {}, sk[1]));
    at0(9, 45); const c = logi.calculate({ orderId: oB.id }); const v = c.recommended;
    if (v) { const sh = logi.createShipment({ orderId: oB.id, vehicleId: v.vehicleId, driverId: db.val('SELECT driver_id FROM vehicles WHERE id=?', v.vehicleId), distanceKm: 320, plannedDeparture: new Date(Date.now() + 2 * 3600000).toISOString(), assignedTo: sk[2].id }, lg);
      at0(10, 0); const lt = db.get('SELECT * FROM loading_tasks WHERE shipment_id=?', sh.id); logi.startLoading(lt.id, sk[2]); logi.loadPallet(lt.id, { code: db.val('SELECT pallet_no FROM pallets WHERE shipment_id=? ORDER BY id LIMIT 1', sh.id) }, sk[2]); }
  }

  // C) shipment in transit (dispatched this morning) + D) a late one
  for (const [cust, sku, qty, depH, etaShift] of [['Samarqand Green Power', 'SP-550W-M', 93, 6, 6], ['Buxoro Agro Klaster', 'SP-600W-BF', 62, -20, -3]]) {
    at(-2, 10);
    const o = orders.createOrder({ customerId: cid(cust), items: [{ productId: pid(sku), qty }], dueDate: new Date(today.getTime()).toISOString(), destination: dest[cust] }, mgr);
    if (o.status !== 'RESERVED') continue;
    orderSeq++;
    const day = -1;
    const sh = fulfil(o.id, day, false);
    if (!sh) continue;
    at(day, depH < 0 ? 13 : 12, 30);
    // ETA relative to the real clock: one still on the way, one already overdue
    logi.dispatch(sh.id, { eta: new Date(Date.now() + etaShift * 3600000).toISOString() }, lg);
  }

  // E) urgent project order that exceeds free stock → SHORTAGE (critical, due tomorrow)
  at0(9, 20);
  const freeNow = inv.freeQty(pid('SP-550W-M'));
  const bigQty = Math.max(310, Math.ceil((freeNow + 124 + 180) / 31) * 31);
  orders.createOrder({ customerId: cid('Navoiy Quyosh Energiya MChJ'), projectId: pNav, items: [{ productId: pid('SP-550W-M'), qty: bigQty }], dueDate: new Date(today.getTime() + 1 * 86400000 + 12 * 3600000).toISOString(), destination: dest['Navoiy Quyosh Energiya MChJ'], priority: 'URGENT', notes: 'Navoiy FES 1-bosqich. Jo‘natish ertaga 12:00 gacha.' }, mgr);
  // F) normal order, reserved, waiting for picking
  at0(9, 40);
  const oF = orders.createOrder({ customerId: cid('Qashqadaryo Solar Park'), items: [{ productId: pid('SP-450W-M'), qty: 62 }], dueDate: new Date(today.getTime() + 2 * 86400000).toISOString(), destination: dest['Qashqadaryo Solar Park'] }, mgr);
  if (oF.status === 'RESERVED') { at0(9, 45); orders.createPickTask(oF.id, { assignedTo: sk[2].id }, mgr); }

  // procurement pipeline in various states
  const mk = (sku, sup, qty, stage, expDays, reason) => {
    at(-6, 10); const r = proc.create({ productId: pid(sku), qty, supplierId: db.val('SELECT id FROM suppliers WHERE code=?', sup), reason: reason || 'Minimal zaxirani to‘ldirish', priority: 'HIGH' }, pr);
    if (stage >= 1) { at(-6, 11); proc.approve(r.id, {}, mgr); }
    if (stage >= 2) { at(-6, 12); proc.placeOrder(r.id, {}, pr); }
    if (stage >= 3) { at(-5, 10); proc.supplierConfirm(r.id, { expectedDate: new Date(today.getTime() + expDays * 86400000).toISOString() }, pr); }
    if (stage >= 4) { at(-3, 9); proc.inTransit(r.id, { vehicle: '30 T 777 KA', driver: 'Supplier haydovchisi' }, pr); }
    return r;
  };
  mk('RM-EVA-045', 'SUP-002', 8000, 4, -2, 'EVA minimal darajaga yaqin');       // in transit, 2 days late → SUPPLIER DELAY
  mk('RM-GLASS-32', 'SUP-003', 1200, 3, 0);                                         // confirmed, arriving today
  mk('RM-JBOX-3D', 'SUP-005', 3000, 2, 0);                                          // ordered
  mk('RM-CELL-M10', 'SUP-001', 150000, 1, 0);                                       // approved
  mk('PK-FILM', 'SUP-006', 40, 0, 0);                                               // requested (awaiting approval)
  // make EVA low: consume to near minimum
  at0(7, 10);
  const evaFree = inv.freeQty(pid('RM-EVA-045')); if (evaFree > 5200) inv.issue({ productId: pid('RM-EVA-045'), qty: Math.round(evaFree - 5200), reason: 'Ishlab chiqarishga berildi (2-smena)', reference: 'PRD-TODAY' }, sk[1]);

  // one rework unit sent back to re-QC
  at0(10, 30);
  const q = db.get("SELECT product_id, qty FROM inventory WHERE status='REWORK' AND qty>=1 ORDER BY id LIMIT 1");
  if (q) inv.disposition({ productId: q.product_id, qty: 1, fromStatus: 'REWORK', action: 'REQC', reason: 'Rework yakunlandi (ramka almashtirildi)' }, qc);

  // ---- XETQ / technical documentation ----
  at(-18, 10);
  const ts1 = xetq.createTS({ projectId: pSam, productId: pid('SP-550W-M'), title: 'Quyosh paneli SF-M550-144HC texnik shartlari', model: 'SF-M550-144HC', power: '550 W (±3%)', dimensions: '2279 × 1134 × 35 mm', weight: '28.6 kg', electrical_spec: 'Voc 49.9V; Isc 14.0A; Vmp 41.9V; Imp 13.13A; Max system voltage 1500V DC', material_spec: 'Shisha 3.2mm AR temperlangan; EVA 0.45mm; Backsheet TPT; Alyuminiy ramka 6063-T5', packaging_spec: '31 dona/pallet, vertikal, karton + burchak himoyasi (PS-SF-001)', quality_requirements: '100% EL test, flash test, Hi-Pot 1500V, vizual nazorat A sinf', standards: 'IEC 61215-1:2021; IEC 61730-1:2023; O‘z DSt IEC 61215' }, qc);
  at(-17, 10); xetq.setTSStatus(ts1.id, { status: 'IN_REVIEW' }, qc); xetq.setTSStatus(ts1.id, { status: 'APPROVED' }, mgr);
  at(-4, 10); const ts2 = xetq.createTS({ projectId: pNav, productId: pid('SP-600W-BF'), title: 'Bifacial SF-BF600-132 texnik shartlari', model: 'SF-BF600-132', power: '600 W', dimensions: '2172 × 1303 × 33 mm', weight: '32.5 kg', packaging_spec: '31 dona/pallet, stack taqiqlanadi', standards: 'IEC 61215; IEC 61730; IEC TS 60904-1-2' }, qc);
  const mkDoc = (type, title, project, content) => docs.createDocument({ docType: type, title, projectId: project, content: `<h2>${title}</h2><p>${content}</p>` }, qc).id;
  at(-15, 11);
  const dDs = mkDoc('DATASHEET', 'SF-M550-144HC Datasheet', pSam, 'Elektr va mexanik parametrlar, STC/NOCT sharoitlari.');
  const dCert = mkDoc('CERTIFICATE', 'IEC 61215/61730 sertifikati', pSam, 'Sertifikat №IEC-2026-0415, amal qilish muddati 2029.');
  const dDrw = mkDoc('DRAWING', 'Panel montaj chizmasi DWG-550-01', pSam, 'Montaj teshiklari, ramka profili, kabel uzunligi 300/300 mm.');
  const dTest = mkDoc('TEST_RESULTS', 'Flash test va EL natijalari (partiya B-2608)', pSam, 'Namuna 32 dona: o‘rtacha Pmax 551.8 W, EL nuqsonsiz.');
  const dPack = mkDoc('PACKING_SPEC', 'Qadoqlash spetsifikatsiyasi PS-SF-001 v2.1', pSam, '31 dona/pallet, vertikal, 1260 mm balandlik, brutto ~960 kg.');
  at(-14, 11); for (const d of [dDs, dCert, dDrw]) { docs.setDocStatus(d, { status: 'IN_REVIEW' }, qc); docs.setDocStatus(d, { status: 'APPROVED' }, mgr); }
  at(-13, 12);
  const x1 = xetq.createSubmission({ title: 'SF-M550 panellari — Samarqand 50 MW texnik paketi', projectId: pSam, productId: pid('SP-550W-M'), qty: 90900, tsId: ts1.id, documentIds: [dDs, dCert, dDrw], packingSpec: 'PS-SF-001 v2.0', logisticsInfo: 'Yarim tirkama 13.6 m, 20 pallet/reys', responsibleId: qc.id }, qc);
  for (const [s, dd] of [['INTERNAL_REVIEW', -13], ['READY_FOR_SUBMISSION', -12], ['SUBMITTED', -12], ['UNDER_REVIEW', -10]]) { at(dd, 14); xetq.transition(x1.id, { status: s, comment: s === 'UNDER_REVIEW' ? 'XETQ ro‘yxatga oldi' : '' }, s === 'UNDER_REVIEW' ? mgr : qc); }
  at(-6, 11); xetq.transition(x1.id, { status: 'REVISION_REQUIRED', comment: 'Qadoqlash spetsifikatsiyasi eski versiyada', requiredChanges: 'PS-SF-001 v2.1 ga yangilash, TS v1.1 biriktirish, sinov natijalarini qo‘shish', fixOwnerId: qc.id, deadline: new Date(today.getTime() - 1 * 86400000).toISOString(), reviewer: 'XETQ ekspert: A. Nurmatov' }, mgr);
  at(-12, 12);
  const x2 = xetq.createSubmission({ title: 'SF-M550 — Tijorat tomlari 5 MW texnik paketi', projectId: pTsh, productId: pid('SP-550W-M'), qty: 9100, tsId: ts1.id, documentIds: [dDs, dCert], responsibleId: qc.id }, qc);
  for (const [s, dd] of [['INTERNAL_REVIEW', -12], ['READY_FOR_SUBMISSION', -11], ['SUBMITTED', -11], ['UNDER_REVIEW', -9], ['APPROVED', -5]]) { at(dd, 15); xetq.transition(x2.id, { status: s, comment: s === 'APPROVED' ? 'Kelishildi, №XETQ-TS-0932' : '' }, ['UNDER_REVIEW', 'APPROVED'].includes(s) ? mgr : qc); }
  at(-8, 10); const ts11 = xetq.reviseTS(ts1.id, { revisionNote: 'Qadoqlash spetsifikatsiyasi yangilandi (PS-SF-001 v2.1), og‘irlik aniqlashtirildi', packaging_spec: '31 dona/pallet, vertikal, karton + 8 burchak himoyasi, strech 3 qatlam (PS-SF-001 v2.1)', weight: '28.6 kg (±0.5)' }, qc);
  at(-7, 10); xetq.setTSStatus(ts11.id, { status: 'IN_REVIEW' }, qc); xetq.setTSStatus(ts11.id, { status: 'APPROVED' }, mgr);
  at(-3, 12);
  const x3 = xetq.createSubmission({ title: 'SF-M550 — Samarqand (2-bosqich) texnik paketi', projectId: pSam, productId: pid('SP-550W-M'), qty: 40000, tsId: ts11.id, documentIds: [dDs, dCert, dDrw, dTest, dPack], packingSpec: 'PS-SF-001 v2.1', logisticsInfo: 'Yarim tirkama 13.6 m', responsibleId: qc.id }, qc);
  for (const [s, dd] of [['INTERNAL_REVIEW', -3], ['READY_FOR_SUBMISSION', -2], ['SUBMITTED', -1]]) { at(dd, 15); xetq.transition(x3.id, { status: s }, qc); }
  at(-1, 16); xetq.createSubmission({ title: 'Bifacial 600W — Navoiy texnik paketi', projectId: pNav, productId: pid('SP-600W-BF'), qty: 20000, tsId: ts2.id, documentIds: [], responsibleId: qc.id }, qc);

  // maintenance / unavailable vehicles
  at0(7); for (const [code, st] of [['V-08', 'MAINTENANCE'], ['V-07', 'UNAVAILABLE']]) { const v = db.get('SELECT * FROM vehicles WHERE code=?', code); if (v.status === 'AVAILABLE') logi.setVehicleStatus(v.id, { status: st, notes: st === 'MAINTENANCE' ? 'Tormoz tizimi ta’miri, 25.09 gacha' : 'Ijara shartnomasi to‘xtatilgan' }, lg); }
  // open inventory count
  at0(11); inv.createCount({ warehouseId: 'WH-03', zoneId: 'WH-03-B' }, mgr);
  // historic one-off alerts (QC/short receipts) were handled at the time
  db.run("UPDATE ai_events SET status='RESOLVED', resolved_at=? WHERE type IN ('QC_FAILED','RECEIVING_SHORT','ROOT_CAUSE') AND created_at<?", clock.iso(), new Date(today.getTime() - 86400000).toISOString());
  clock.set(null);
  // leave the morning production receipt awaiting QC (RECEIVING)
  return { todayProd, dir };
}

/** System account used by the AI dispatcher for audit attribution (cannot log in). */
function systemUsers() {
  if (!db.get("SELECT id FROM users WHERE username='ai.dispetcher'")) db.insert('users', { username: 'ai.dispetcher', password_hash: 'disabled$', full_name: 'AI dispetcher', role_code: 'LOGISTICS', active: 1, created_at: clock.iso() });
  if (!db.get("SELECT id FROM users WHERE username='integratsiya'")) db.insert('users', { username: 'integratsiya', password_hash: 'disabled$', full_name: 'Tashqi tizim (API)', role_code: 'MANAGER', active: 1, created_at: clock.iso() });
  ensureMainAdmin();
}

/** Asosiy admin (.env: SUPERADMIN_LOGIN / SUPERADMIN_PASSWORD) har ishga tushishda kafolatlanadi:
 *  bo‘lmasa yaratiladi; bor bo‘lsa — SUPERADMIN, faol, bo‘limga cheklanmagan, bloklanmagan va .env paroli bilan kiradi.
 *  Boshqa super admin bo‘lsa — ADMIN ga o‘tkaziladi (tizimda asosiy admin bitta). */
function ensureMainAdmin() {
  const login = (process.env.SUPERADMIN_LOGIN || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const pass = process.env.SUPERADMIN_PASSWORD || '';
  if (!login || !pass) return;
  const name = (process.env.SUPERADMIN_NAME || process.env.SUPERADMIN_LOGIN).trim();
  const u = db.get('SELECT * FROM users WHERE username=?', login);
  if (!u) {
    db.insert('users', { username: login, password_hash: auth.hashPassword(pass), full_name: name, role_code: 'SUPERADMIN', active: 1, created_at: clock.iso() });
    console.log(`Asosiy admin yaratildi: ${login}`);
  } else {
    const fix = {};
    if (u.role_code !== 'SUPERADMIN') fix.role_code = 'SUPERADMIN';
    if (!u.active) fix.active = 1;
    if (u.section) fix.section = null;
    if (u.locked_until || u.failed_logins) { fix.locked_until = null; fix.failed_logins = 0; }
    if (!String(u.password_hash).startsWith('scrypt$') || !auth.verifyPassword(pass, u.password_hash)) fix.password_hash = auth.hashPassword(pass);
    if (Object.keys(fix).length) {
      db.update('users', u.id, fix);
      if (fix.password_hash || fix.role_code) db.run('DELETE FROM sessions WHERE user_id=?', u.id);
      db.audit(null, 'MAIN_ADMIN_SYNC', 'users', login, { changed: Object.keys(fix).map((k) => (k === 'password_hash' ? 'parol' : k)) });
      console.log(`Asosiy admin .env bo‘yicha yangilandi: ${login} (${Object.keys(fix).map((k) => (k === 'password_hash' ? 'parol' : k)).join(', ')})`);
    }
  }
  const main = db.get('SELECT id FROM users WHERE username=?', login);
  for (const other of db.all("SELECT id, username FROM users WHERE role_code='SUPERADMIN' AND id<>?", main.id)) {
    db.update('users', other.id, { role_code: 'ADMIN' });
    db.run('DELETE FROM sessions WHERE user_id=?', other.id);
    db.audit(null, 'SUPERADMIN_DEMOTED', 'users', other.username, { reason: `asosiy admin: ${login}` });
    console.log(`Oldingi super admin ADMIN ga o‘tkazildi: ${other.username}`);
  }
}

function run(mode) {
  console.log(`Seeding database (${mode})…`);
  const t = Date.now();
  db.tx(() => master(mode === 'demo'));
  db.tx(() => systemUsers());
  if (mode === 'demo') db.tx(() => demoHistory());
  clock.set(null);
  console.log(`Seed tayyor: ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

module.exports = { run, systemUsers };
