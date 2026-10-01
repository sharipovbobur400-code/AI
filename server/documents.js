'use strict';
// Document control: admin-configurable templates, generated logistics documents, uploads, versions with SHA-256 integrity.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { clock, bad, notFound, V, round } = require('./core');

let FILE_DIR = path.join(__dirname, '..', 'data', 'files');
// serverless (Vercel): the disk is temporary, so uploaded files are stored inside the database
const FILES_IN_DB = !!process.env.VERCEL || process.env.WMS_SERVERLESS === '1';
function setFileDir(d) { FILE_DIR = d; fs.mkdirSync(FILE_DIR, { recursive: true }); }

const DOC_TYPES = {
  PACKING_LIST: 'Packing List', DELIVERY_NOTE: 'Delivery Note (Yuk xati)', LOADING_SHEET: 'Loading Sheet (Yuklash varaqasi)', WAREHOUSE_ISSUE: 'Warehouse Issue Document',
  SHIPMENT_RECORD: 'Shipment Record', TRANSPORT_ASSIGNMENT: 'Transport Assignment', MATERIAL_REQUEST: 'Material Request', PURCHASE_REQUEST: 'Purchase Request',
  RECEIVING_REPORT: 'Receiving Report', QC_REPORT: 'QC Report', TECHNICAL_PACKAGE: 'Technical Document Package',
  DRAWING: 'Chizma (Drawing)', DATASHEET: 'Datasheet', CERTIFICATE: 'Sertifikat', TEST_RESULTS: 'Test natijalari', QUALITY_DOC: 'Sifat hujjati',
  PACKING_SPEC: 'Qadoqlash spetsifikatsiyasi', LOGISTICS_SPEC: 'Logistika spetsifikatsiyasi', BOM: 'BOM', TEST_PROTOCOL: 'Test protokoli', OTHER: 'Boshqa',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const getPath = (obj, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
function render(tpl, ctx) {
  const withEach = tpl.replace(/{{#each ([\w.]+)}}([\s\S]*?){{\/each}}/g, (_, key, inner) => (getPath(ctx, key) || []).map((item, i) =>
    inner.replace(/{{\s*([@\w.]+)\s*}}/g, (m, k) => (k === '@index' ? String(i + 1) : esc(getPath(item, k.replace(/^this\./, '')) ?? getPath(ctx, k))))).join(''));
  return withEach.replace(/{{\s*([\w.]+)\s*}}/g, (_, k) => esc(getPath(ctx, k)));
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const STYLE = `<style>body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:28px;font-size:12px}h1{font-size:18px;margin:0 0 4px}.muted{color:#555}
table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #999;padding:5px 6px;text-align:left}th{background:#eee}.r{text-align:right}
.hdr{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:12px}.sig{display:flex;gap:40px;margin-top:36px}.sig div{flex:1;border-top:1px solid #111;padding-top:4px}</style>`;
const HEAD = `<div class="hdr"><div><b>{{company}}</b><br><span class="muted">{{company_address}}</span></div><div class="r"><h1>{{title}}</h1>№ {{doc_no}} · {{date}}</div></div>`;
const DEFAULT_TEMPLATES = {
  PACKING_LIST: `${HEAD}<p>Buyurtma: <b>{{order.order_no}}</b> · Mijoz: <b>{{customer}}</b> · Loyiha: {{project}}<br>Jo‘natma: {{shipment.ship_no}} · Manzil: {{shipment.destination}}</p>
<table><tr><th>#</th><th>Pallet</th><th>SKU</th><th>Mahsulot</th><th class="r">Soni</th><th class="r">Netto, kg</th><th class="r">Brutto, kg</th><th>O‘lcham, mm</th><th>Serial raqamlar</th></tr>
{{#each pallets}}<tr><td>{{@index}}</td><td>{{pallet_no}}</td><td>{{sku}}</td><td>{{name}}</td><td class="r">{{qty}}</td><td class="r">{{net_weight_kg}}</td><td class="r">{{gross_weight_kg}}</td><td>{{dims}}</td><td>{{serial_range}}</td></tr>{{/each}}
<tr><th colspan="4">Jami</th><th class="r">{{totals.qty}}</th><th class="r">{{totals.net}}</th><th class="r">{{totals.gross}}</th><th colspan="2">Hajm: {{totals.volume}} m³ · Pallet: {{totals.pallets}}</th></tr></table>
<div class="sig"><div>Omborchi</div><div>Logist</div><div>Haydovchi</div></div>`,
  DELIVERY_NOTE: `${HEAD}<p>Yuk jo‘natuvchi: <b>{{company}}</b><br>Yuk oluvchi: <b>{{customer}}</b> · Manzil: {{shipment.destination}}<br>Transport: {{vehicle.type}} {{vehicle.model}}, davlat raqami {{vehicle.plate}} · Haydovchi: {{driver.full_name}} ({{driver.phone}})</p>
<table><tr><th>#</th><th>Mahsulot</th><th>SKU</th><th class="r">Soni</th><th>Birlik</th><th class="r">Brutto, kg</th></tr>{{#each lines}}<tr><td>{{@index}}</td><td>{{name}}</td><td>{{sku}}</td><td class="r">{{qty}}</td><td>{{unit}}</td><td class="r">{{gross}}</td></tr>{{/each}}</table>
<p>Jami pallet: {{totals.pallets}} · Umumiy og‘irlik: {{totals.gross}} kg · Hajm: {{totals.volume}} m³</p><div class="sig"><div>Topshirdi</div><div>Haydovchi</div><div>Qabul qildi</div></div>`,
  LOADING_SHEET: `${HEAD}<p>Jo‘natma {{shipment.ship_no}} · Transport {{vehicle.code}} ({{vehicle.type}}, {{vehicle.plate}}) · Rejalashtirilgan jo‘nash: {{shipment.planned_departure}}</p>
<table><tr><th>Ketma-ketlik</th><th>Pallet</th><th>Joylashuv</th><th class="r">Brutto, kg</th><th>Yuklandi</th></tr>{{#each sequence}}<tr><td>{{seq}}</td><td>{{palletNo}}</td><td>{{position}}</td><td class="r">{{weight}}</td><td>☐</td></tr>{{/each}}</table>
<p><b>Ogohlantirishlar:</b></p><ul>{{#each warnings}}<li>{{text}}</li>{{/each}}</ul><div class="sig"><div>Yuklovchi</div><div>Logist</div><div>Haydovchi</div></div>`,
  WAREHOUSE_ISSUE: `${HEAD}<p>Ombordan chiqarish asosi: jo‘natma {{shipment.ship_no}}, buyurtma {{order.order_no}}</p><table><tr><th>#</th><th>SKU</th><th>Mahsulot</th><th class="r">Soni</th><th>Birlik</th></tr>{{#each lines}}<tr><td>{{@index}}</td><td>{{sku}}</td><td>{{name}}</td><td class="r">{{qty}}</td><td>{{unit}}</td></tr>{{/each}}</table><div class="sig"><div>Ombor mudiri</div><div>Omborchi</div></div>`,
  SHIPMENT_RECORD: `${HEAD}<table><tr><th>Jo‘natma</th><td>{{shipment.ship_no}}</td><th>Buyurtma</th><td>{{order.order_no}}</td></tr><tr><th>Mijoz</th><td>{{customer}}</td><th>Loyiha</th><td>{{project}}</td></tr>
<tr><th>Transport</th><td>{{vehicle.code}} {{vehicle.plate}}</td><th>Haydovchi</th><td>{{driver.full_name}}</td></tr><tr><th>Pallet</th><td>{{totals.pallets}}</td><th>Og‘irlik / hajm</th><td>{{totals.gross}} kg / {{totals.volume}} m³</td></tr>
<tr><th>Yuklash</th><td>{{shipment.loading_start}} — {{shipment.loading_end}}</td><th>Manzil</th><td>{{shipment.destination}}</td></tr></table>`,
  TRANSPORT_ASSIGNMENT: `${HEAD}<p>{{vehicle.type}} {{vehicle.model}} ({{vehicle.code}}, {{vehicle.plate}}) jo‘natma {{shipment.ship_no}} uchun biriktirildi.</p><table><tr><th>Ko‘rsatkich</th><th class="r">Talab</th><th class="r">Sig‘im</th><th class="r">Band, %</th></tr>
<tr><td>Og‘irlik, kg</td><td class="r">{{totals.gross}}</td><td class="r">{{vehicle.payload_kg}}</td><td class="r">{{util.weight}}</td></tr><tr><td>Hajm, m³</td><td class="r">{{totals.volume}}</td><td class="r">{{vehicle.volume_m3}}</td><td class="r">{{util.volume}}</td></tr>
<tr><td>Pallet</td><td class="r">{{totals.pallets}}</td><td class="r">—</td><td class="r">{{util.pallets}}</td></tr></table><p>Haydovchi: {{driver.full_name}}, guvohnoma {{driver.license_no}}</p>`,
  PURCHASE_REQUEST: `${HEAD}<table><tr><th>Supplier</th><td>{{supplier.company}}</td></tr><tr><th>Material</th><td>{{product.sku}} — {{product.name}}</td></tr><tr><th>Miqdor</th><td>{{pr.qty}} {{product.unit}}</td></tr>
<tr><th>Kerakli sana</th><td>{{pr.required_date}}</td></tr><tr><th>Muhimlik</th><td>{{pr.priority}}</td></tr><tr><th>Sabab</th><td>{{pr.reason}}</td></tr><tr><th>Ombor</th><td>{{pr.warehouse_id}}</td></tr><tr><th>Holat</th><td>{{pr.status}}</td></tr></table><div class="sig"><div>Tuzdi</div><div>Tasdiqladi</div></div>`,
  MATERIAL_REQUEST: `${HEAD}<table><tr><th>Material</th><td>{{product.sku}} — {{product.name}}</td></tr><tr><th>Miqdor</th><td>{{pr.qty}} {{product.unit}}</td></tr><tr><th>Ishlab chiqarish buyurtmasi</th><td>{{pr.production_order}}</td></tr><tr><th>Sabab</th><td>{{pr.reason}}</td></tr></table><div class="sig"><div>So‘radi</div><div>Ombor</div></div>`,
  RECEIVING_REPORT: `${HEAD}<table><tr><th>Manba</th><td>{{rcv.source}}</td><th>Supplier</th><td>{{supplier}}</td></tr><tr><th>Mahsulot</th><td>{{product.sku}} — {{product.name}}</td><th>Partiya</th><td>{{batch}}</td></tr>
<tr><th>Kutilgan</th><td>{{rcv.qty_expected}}</td><th>Qabul qilindi</th><td>{{rcv.qty_received}}</td></tr><tr><th>Yetkazish №</th><td>{{rcv.delivery_number}}</td><th>Transport / haydovchi</th><td>{{rcv.vehicle}} / {{rcv.driver}}</td></tr><tr><th>Holat</th><td>{{rcv.status}}</td><th>Og‘irlik</th><td>{{rcv.weight_kg}} kg</td></tr></table><div class="sig"><div>Omborchi</div><div>QC</div></div>`,
  QC_REPORT: `${HEAD}<table><tr><th>Kirim</th><td>{{rcv.rcv_no}}</td><th>Mahsulot</th><td>{{product.sku}}</td></tr>{{#each checks}}<tr><td>{{qc_no}}</td><td>O‘tdi: {{passed_qty}}</td><td>Yiqildi: {{failed_qty}} · Rework: {{rework_qty}}</td><td>{{result}} — {{notes}}</td></tr>{{/each}}</table><div class="sig"><div>QC inspektor</div></div>`,
  TECHNICAL_PACKAGE: `${HEAD}<p>Loyiha: <b>{{project}}</b> · Mahsulot: {{product}} · Miqdor: {{sub.qty}}</p><p>Texnik shart: {{ts.ts_no}} v{{ts.version}} ({{ts.status}})</p>
<table><tr><th>#</th><th>Hujjat</th><th>Turi</th><th>Versiya</th><th>Holat</th><th>SHA-256</th></tr>{{#each docs}}<tr><td>{{@index}}</td><td>{{doc_no}} — {{title}}</td><td>{{doc_type}}</td><td>{{current_version}}</td><td>{{status}}</td><td style="font-size:9px">{{sha256}}</td></tr>{{/each}}</table>
<p>Qadoqlash: {{sub.packing_spec}}<br>Logistika: {{sub.logistics_info}}</p><div class="sig"><div>Mas'ul: {{responsible}}</div><div>Tasdiqladi</div></div>`,
};
function seedTemplates() {
  for (const [code, html] of Object.entries(DEFAULT_TEMPLATES)) db.run('INSERT OR IGNORE INTO doc_templates(code,name,html,updated_at) VALUES(?,?,?,?)', code, DOC_TYPES[code], html, clock.iso());
}
function saveTemplate(code, input, user) {
  if (!DOC_TYPES[code]) throw notFound('Shablon');
  const html = V.str(input.html, 'Shablon HTML', { max: 100000 });
  if (/<script|on\w+\s*=|javascript:/i.test(html)) throw bad('Shablonda skript yoki event-handler ishlatish mumkin emas');
  db.run('INSERT INTO doc_templates(code,name,html,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET html=excluded.html, updated_by=excluded.updated_by, updated_at=excluded.updated_at', code, DOC_TYPES[code], html, user?.id, clock.iso());
  db.audit(user, 'TEMPLATE_UPDATE', 'doc_templates', code);
  return { ok: true };
}

function nextVersion(v, major) { const [a, b] = String(v || '0.0').split('.').map(Number); return major ? `${a + 1}.0` : `${a}.${(b || 0) + 1}`; }

function addVersion(docId, { content, file, changeNote, major, version }, user) {
  const d = db.get('SELECT * FROM documents WHERE id=?', docId); if (!d) throw notFound('Hujjat');
  const ver = version || (d.current_version ? nextVersion(d.current_version, major) : '1.0');
  if (db.val('SELECT COUNT(*) FROM document_versions WHERE document_id=? AND version=?', docId, ver)) throw bad(`Versiya ${ver} allaqachon mavjud`);
  let rec = { content: content || null, sha256: sha(Buffer.from(content || '', 'utf8')) };
  if (file) {
    const buf = Buffer.from(V.str(file.base64, 'Fayl', { max: 15_000_000 }), 'base64');
    const maxMb = FILES_IN_DB ? 3 : 10; // Vercel request body limit is 4.5 MB (base64 adds ~33%)
    if (buf.length > maxMb * 1024 * 1024) throw bad(`Fayl hajmi ${maxMb} MB dan oshmasligi kerak`);
    const checked = require('./filecheck').check(buf, file.name); // type allow-list, real content check, antivirus
    const mime = checked.mime;
    const h = sha(buf); const safe = String(file.name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 100);
    if (!FILES_IN_DB) { fs.mkdirSync(FILE_DIR, { recursive: true }); fs.writeFileSync(path.join(FILE_DIR, `${h}-${safe}`), buf); }
    rec = { content: content || null, file_path: `${h}-${safe}`, file_name: safe, mime, size: buf.length, sha256: h, file_data: FILES_IN_DB ? buf : undefined };
    db.audit(user, 'FILE_SCANNED', 'documents', d.doc_no, { file: safe, type: checked.label, antivirus: checked.scanner || 'o‘chirilgan/topilmadi' });
  }
  db.run("UPDATE document_versions SET status='ARCHIVED' WHERE document_id=? AND status='CURRENT'", docId);
  db.insert('document_versions', { document_id: docId, version: ver, ...rec, status: 'CURRENT', change_note: changeNote || null, author_id: user?.id, created_at: clock.iso() });
  db.update('documents', docId, { current_version: ver, updated_at: clock.iso(), status: ['APPROVED', 'ISSUED'].includes(d.status) && !d.ref_type ? 'DRAFT' : d.status });
  db.audit(user, 'DOC_VERSION', 'documents', d.doc_no, { version: ver, sha256: rec.sha256 });
  return ver;
}

function createDocument(input, user) {
  return db.tx(() => {
    const type = V.oneOf(input.docType, 'Hujjat turi', Object.keys(DOC_TYPES));
    const no = db.nextNo('DOC');
    const id = db.insert('documents', { doc_no: no, doc_type: type, title: V.str(input.title, 'Nomi', { max: 300 }), project_id: V.optId(input.projectId, 'Loyiha'),
      ref_type: input.refType || null, ref_id: input.refId || null, status: input.status || 'DRAFT', author_id: user?.id, created_at: clock.iso(), updated_at: clock.iso() });
    if (!input.content && !input.file) throw bad('Hujjat mazmuni yoki fayl kerak');
    const ver = addVersion(id, { content: input.content, file: input.file, changeNote: 'Dastlabki versiya' }, user);
    db.audit(user, 'DOC_CREATE', 'documents', no, { type });
    db.emit('DOCUMENT_CREATED', { id, docNo: no, type });
    return { id, docNo: no, version: ver };
  });
}
function newVersion(docId, input, user) { return db.tx(() => ({ version: addVersion(docId, { content: input.content, file: input.file, changeNote: V.str(input.changeNote, 'O‘zgarish izohi', { max: 500 }), major: !!input.major }, user) })); }
function setDocStatus(docId, input, user) {
  return db.tx(() => {
    const d = db.get('SELECT * FROM documents WHERE id=?', docId); if (!d) throw notFound('Hujjat');
    const to = V.oneOf(input.status, 'Holat', ['DRAFT', 'IN_REVIEW', 'APPROVED', 'ARCHIVED']);
    const allowed = { DRAFT: ['IN_REVIEW', 'ARCHIVED'], IN_REVIEW: ['APPROVED', 'DRAFT'], APPROVED: ['ARCHIVED', 'DRAFT'], ISSUED: ['ARCHIVED'], ARCHIVED: [] };
    if (!(allowed[d.status] || []).includes(to)) throw bad(`${d.status} → ${to} o‘tish mumkin emas`);
    if (to === 'APPROVED' && d.author_id === user?.id && !['DIRECTOR', 'ADMIN'].includes(user.role)) throw bad('Muallif o‘z hujjatini tasdiqlay olmaydi');
    db.update('documents', d.id, { status: to, updated_at: clock.iso(), ...(to === 'APPROVED' ? { approver_id: user?.id, approved_at: clock.iso() } : {}) });
    db.history('document', d.id, d.status, to, user, input.note);
    db.audit(user, `DOC_${to}`, 'documents', d.doc_no);
    if (to === 'APPROVED') db.emit('DOCUMENT_APPROVED', { id: d.id, docNo: d.doc_no, kind: 'document' });
    return { status: to };
  });
}
function verify(versionId) {
  const v = db.get('SELECT * FROM document_versions WHERE id=?', versionId); if (!v) throw notFound('Versiya');
  let actual;
  if (v.file_data) actual = sha(Buffer.from(v.file_data));
  else if (v.file_path) { const f = path.join(FILE_DIR, v.file_path); actual = fs.existsSync(f) ? sha(fs.readFileSync(f)) : null; } else actual = sha(Buffer.from(v.content || '', 'utf8'));
  return { versionId: v.id, stored: v.sha256, actual, valid: actual === v.sha256 };
}
function fileOf(versionId) { const v = db.get('SELECT * FROM document_versions WHERE id=?', versionId); if (!v || !v.file_path) throw notFound('Fayl'); return { path: path.join(FILE_DIR, v.file_path), data: v.file_data ? Buffer.from(v.file_data) : null, name: v.file_name, mime: v.mime }; }

// ---- Generation from templates --------------------------------------------------
function baseCtx(code, docNo) { return { company: db.setting('company_name', 'Solar Factory'), company_address: db.setting('company_address', ''), title: DOC_TYPES[code], doc_no: docNo, date: clock.today() }; }
function shipmentCtx(shipmentId) {
  const s = db.get('SELECT * FROM shipments WHERE id=?', shipmentId);
  const o = db.get('SELECT * FROM orders WHERE id=?', s.order_id);
  const pallets = db.all(`SELECT pl.*, p.sku, p.name, p.unit FROM shipment_items si JOIN pallets pl ON pl.id=si.pallet_id JOIN products p ON p.id=pl.product_id WHERE si.shipment_id=? ORDER BY si.load_seq`, s.id)
    .map((p) => { const sr = db.all('SELECT serial FROM serial_numbers WHERE pallet_id=? ORDER BY serial', p.id).map((x) => x.serial); return { ...p, dims: `${p.length_mm}×${p.width_mm}×${p.height_mm}`, serial_range: sr.length ? `${sr[0]} … ${sr[sr.length - 1]} (${sr.length})` : '—' }; });
  const lines = Object.values(pallets.reduce((a, p) => { a[p.sku] ||= { sku: p.sku, name: p.name, unit: p.unit, qty: 0, gross: 0 }; a[p.sku].qty += p.qty; a[p.sku].gross = round(a[p.sku].gross + p.gross_weight_kg, 1); return a; }, {}));
  const lt = db.get('SELECT * FROM loading_tasks WHERE shipment_id=? ORDER BY id DESC', s.id);
  const ta = db.get('SELECT * FROM transport_assignments WHERE shipment_id=? ORDER BY id DESC', s.id) || {};
  return { shipment: s, order: o, customer: db.val('SELECT name FROM customers WHERE id=?', o.customer_id), project: o.project_id ? db.val("SELECT code || ' — ' || name FROM projects WHERE id=?", o.project_id) : '—',
    vehicle: db.get('SELECT * FROM vehicles WHERE id=?', s.vehicle_id) || {}, driver: db.get('SELECT * FROM drivers WHERE id=?', s.driver_id) || {}, pallets, lines,
    sequence: lt ? JSON.parse(lt.sequence || '[]') : [], warnings: lt ? JSON.parse(lt.warnings || '[]').map((t) => ({ text: t })) : [],
    util: { weight: ta.weight_util, volume: ta.volume_util, pallets: ta.pallet_util },
    totals: { qty: pallets.reduce((a, p) => a + p.qty, 0), net: round(pallets.reduce((a, p) => a + p.net_weight_kg, 0), 1), gross: round(pallets.reduce((a, p) => a + p.gross_weight_kg, 0), 1), volume: round(pallets.reduce((a, p) => a + p.volume_m3, 0), 2), pallets: pallets.length } };
}
function contextFor(code, refType, refId) {
  if (refType === 'shipment') return shipmentCtx(refId);
  if (refType === 'purchase_request') { const pr = db.get('SELECT * FROM purchase_requests WHERE id=?', refId); if (!pr) throw notFound('Zayavka'); return { pr, product: db.get('SELECT * FROM products WHERE id=?', pr.product_id), supplier: db.get('SELECT * FROM suppliers WHERE id=?', pr.supplier_id) || {} }; }
  if (refType === 'receiving') {
    const rcv = db.get('SELECT * FROM receiving_orders WHERE id=?', refId); if (!rcv) throw notFound('Kirim');
    return { rcv, product: db.get('SELECT * FROM products WHERE id=?', rcv.product_id), supplier: rcv.supplier_id ? db.val('SELECT company FROM suppliers WHERE id=?', rcv.supplier_id) : '—',
      batch: db.val('SELECT batch_no FROM product_batches WHERE id=?', rcv.batch_id), checks: db.all('SELECT * FROM quality_checks WHERE receiving_id=?', rcv.id) };
  }
  if (refType === 'xetq') {
    const sub = db.get('SELECT * FROM xetq_submissions WHERE id=?', refId); if (!sub) throw notFound('XETQ');
    const ids = JSON.parse(sub.document_ids || '[]');
    return { sub, project: db.val("SELECT code || ' — ' || name FROM projects WHERE id=?", sub.project_id), product: db.val("SELECT sku || ' ' || name FROM products WHERE id=?", sub.product_id),
      ts: db.get('SELECT * FROM technical_specifications WHERE id=?', sub.ts_id) || {}, responsible: db.val('SELECT full_name FROM users WHERE id=?', sub.responsible_id),
      docs: ids.map((id) => db.get(`SELECT d.*, (SELECT sha256 FROM document_versions v WHERE v.document_id=d.id AND v.status='CURRENT') sha256 FROM documents d WHERE d.id=?`, id)).filter(Boolean) };
  }
  throw bad('Hujjat manbasi noto‘g‘ri');
}
const REF_OK = { shipment: ['PACKING_LIST', 'DELIVERY_NOTE', 'LOADING_SHEET', 'WAREHOUSE_ISSUE', 'SHIPMENT_RECORD', 'TRANSPORT_ASSIGNMENT'], purchase_request: ['PURCHASE_REQUEST', 'MATERIAL_REQUEST'], receiving: ['RECEIVING_REPORT', 'QC_REPORT'], xetq: ['TECHNICAL_PACKAGE'] };
function generate(code, refType, refId, user) {
  return db.tx(() => {
    if (!(REF_OK[refType] || []).includes(code)) throw bad(`${code} hujjati ${refType} uchun yaratilmaydi`);
    const tpl = db.get('SELECT html FROM doc_templates WHERE code=?', code); if (!tpl) throw notFound('Shablon');
    const existing = db.get('SELECT * FROM documents WHERE doc_type=? AND ref_type=? AND ref_id=?', code, refType, refId);
    const docNo = existing ? existing.doc_no : db.nextNo('DOC');
    const ctx = { ...baseCtx(code, docNo), ...contextFor(code, refType, refId) };
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(DOC_TYPES[code])} ${esc(docNo)}</title>${STYLE}</head><body>${render(tpl.html, ctx)}</body></html>`;
    if (existing) { const version = addVersion(existing.id, { content: html, changeNote: 'Qayta generatsiya' }, user); return { id: existing.id, docNo, version }; }
    const label = { shipment: () => ctx.shipment.ship_no, purchase_request: () => ctx.pr.pr_no, receiving: () => ctx.rcv.rcv_no, xetq: () => ctx.sub.sub_no }[refType]();
    const id = db.insert('documents', { doc_no: docNo, doc_type: code, title: `${DOC_TYPES[code]} — ${label}`, project_id: ctx.shipment?.project_id || ctx.sub?.project_id || null, ref_type: refType, ref_id: refId,
      status: 'ISSUED', author_id: user?.id, created_at: clock.iso(), updated_at: clock.iso() });
    const version = addVersion(id, { content: html, changeNote: 'Avtomatik generatsiya', version: '1.0' }, user);
    db.emit('DOCUMENT_CREATED', { id, docNo, type: code });
    return { id, docNo, version };
  });
}
function generateShipmentDocs(shipmentId, user) { return REF_OK.shipment.map((c) => ({ type: c, ...generate(c, 'shipment', shipmentId, user) })); }

module.exports = { DOC_TYPES, setFileDir, seedTemplates, saveTemplate, createDocument, newVersion, setDocStatus, verify, fileOf, generate, generateShipmentDocs, nextVersion, render, esc };
