'use strict';
// XETQ: projects, technical specifications (versioned), XETQ submission/approval workflow.
const db = require('./db');
const docs = require('./documents');
const { clock, bad, notFound, V } = require('./core');

const TS_FIELDS = ['title', 'model', 'power', 'dimensions', 'weight', 'electrical_spec', 'material_spec', 'packaging_spec', 'quality_requirements', 'standards'];
const XETQ_FLOW = {
  DRAFT: ['INTERNAL_REVIEW'],
  INTERNAL_REVIEW: ['READY_FOR_SUBMISSION', 'DRAFT'],
  READY_FOR_SUBMISSION: ['SUBMITTED', 'INTERNAL_REVIEW'],
  SUBMITTED: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['REVISION_REQUIRED', 'APPROVED'],
  REVISION_REQUIRED: ['INTERNAL_REVIEW'],
  APPROVED: [],
};
const PACKAGE_TYPES = ['DRAWING', 'DATASHEET', 'CERTIFICATE', 'TEST_RESULTS', 'QUALITY_DOC', 'PACKING_SPEC', 'LOGISTICS_SPEC', 'BOM', 'TEST_PROTOCOL'];

function createProject(input, user) {
  return db.tx(() => {
    const code = V.str(input.code, 'Loyiha kodi', { max: 40 });
    if (db.val('SELECT id FROM projects WHERE code=?', code)) throw bad('Bunday loyiha kodi mavjud');
    let customerId = V.optId(input.customerId, 'Mijoz');
    if (!customerId && input.customerName) customerId = db.val('SELECT id FROM customers WHERE name=?', input.customerName) || db.insert('customers', { name: V.str(input.customerName, 'Mijoz', { max: 200 }), created_at: clock.iso() });
    const id = db.insert('projects', { code, name: V.str(input.name, 'Nomi', { max: 300 }), customer_id: customerId, capacity_mw: V.num(input.capacityMw, 'Quvvat (MW)', { required: false, min: 0 }),
      location: V.str(input.location, 'Joylashuv', { required: false, max: 200 }), requires_xetq: input.requiresXetq ? 1 : 0, status: 'ACTIVE', manager_id: user?.id,
      start_date: input.startDate || null, end_date: input.endDate || null, created_at: clock.iso() });
    db.audit(user, 'PROJECT_CREATE', 'projects', code);
    return { id, code };
  });
}

function createTS(input, user) {
  return db.tx(() => {
    const n = (db.val("SELECT COUNT(DISTINCT ts_no) FROM technical_specifications") || 0) + 1;
    const tsNo = `TS-${String(n).padStart(3, '0')}`;
    const row = { ts_no: tsNo, version: '1.0', project_id: V.optId(input.projectId, 'Loyiha'), product_id: V.optId(input.productId, 'Mahsulot'), status: 'DRAFT', revision_note: 'Dastlabki versiya', created_by: user?.id, created_at: clock.iso() };
    for (const f of TS_FIELDS) row[f] = V.str(input[f], f, { required: f === 'title', max: 5000 });
    const id = db.insert('technical_specifications', row);
    db.history('ts', id, null, 'DRAFT', user);
    db.audit(user, 'TS_CREATE', 'technical_specifications', `${tsNo} v1.0`);
    return { id, tsNo, version: '1.0' };
  });
}
/** New revision: old versions are never deleted; they become ARCHIVED when the new one is approved. */
function reviseTS(id, input, user) {
  return db.tx(() => {
    const t = db.get('SELECT * FROM technical_specifications WHERE id=?', id); if (!t) throw notFound('Texnik shart');
    const latest = db.get('SELECT * FROM technical_specifications WHERE ts_no=? ORDER BY id DESC LIMIT 1', t.ts_no);
    if (latest.status === 'DRAFT' || latest.status === 'IN_REVIEW') throw bad(`${t.ts_no} v${latest.version} hali yakunlanmagan — avval uni tasdiqlang`);
    const version = docs.nextVersion(latest.version, !!input.major);
    const row = { ts_no: t.ts_no, version, project_id: latest.project_id, product_id: latest.product_id, status: 'DRAFT', revision_note: V.str(input.revisionNote, 'O‘zgarish izohi', { max: 1000 }), created_by: user?.id, created_at: clock.iso() };
    for (const f of TS_FIELDS) row[f] = input[f] !== undefined ? V.str(input[f], f, { required: false, max: 5000 }) : latest[f];
    const nid = db.insert('technical_specifications', row);
    db.history('ts', nid, null, 'DRAFT', user, `v${latest.version} → v${version}`);
    db.audit(user, 'TS_REVISE', 'technical_specifications', `${t.ts_no} v${version}`);
    return { id: nid, version };
  });
}
function setTSStatus(id, input, user) {
  return db.tx(() => {
    const t = db.get('SELECT * FROM technical_specifications WHERE id=?', id); if (!t) throw notFound('Texnik shart');
    const to = V.oneOf(input.status, 'Holat', ['IN_REVIEW', 'APPROVED', 'DRAFT']);
    const ok = { DRAFT: ['IN_REVIEW'], IN_REVIEW: ['APPROVED', 'DRAFT'] }[t.status] || [];
    if (!ok.includes(to)) throw bad(`${t.status} → ${to} o‘tish mumkin emas`);
    db.update('technical_specifications', id, { status: to, ...(to === 'APPROVED' ? { approved_by: user?.id, approved_at: clock.iso() } : {}) });
    if (to === 'APPROVED') db.run("UPDATE technical_specifications SET status='ARCHIVED' WHERE ts_no=? AND id<>? AND status='APPROVED'", t.ts_no, id);
    db.history('ts', id, t.status, to, user);
    db.audit(user, `TS_${to}`, 'technical_specifications', `${t.ts_no} v${t.version}`);
    if (to === 'APPROVED') db.emit('DOCUMENT_APPROVED', { kind: 'ts', id, tsNo: t.ts_no, version: t.version });
    return { status: to };
  });
}

function createSubmission(input, user) {
  return db.tx(() => {
    const no = db.nextNo('XETQ');
    const documentIds = (input.documentIds || []).map(Number).filter(Boolean);
    for (const d of documentIds) if (!db.get('SELECT id FROM documents WHERE id=?', d)) throw notFound(`Hujjat ${d}`);
    const id = db.insert('xetq_submissions', { sub_no: no, title: V.str(input.title, 'Nomi', { max: 300 }), project_id: V.id(input.projectId, 'Loyiha'), product_id: V.optId(input.productId, 'Mahsulot'),
      qty: V.num(input.qty, 'Miqdor', { required: false, min: 0 }), ts_id: V.optId(input.tsId, 'Texnik shart'), document_ids: JSON.stringify(documentIds),
      packing_spec: V.str(input.packingSpec, 'Qadoqlash', { required: false, max: 3000 }), logistics_info: V.str(input.logisticsInfo, 'Logistika', { required: false, max: 3000 }),
      responsible_id: V.optId(input.responsibleId, 'Mas’ul') || user?.id, status: 'DRAFT', version: '1.0', created_by: user?.id, created_at: clock.iso(), updated_at: clock.iso() });
    db.history('xetq', id, null, 'DRAFT', user);
    db.audit(user, 'XETQ_CREATE', 'xetq_submissions', no);
    return { id, subNo: no, status: 'DRAFT' };
  });
}
function updateSubmission(id, input, user) {
  return db.tx(() => {
    const s = db.get('SELECT * FROM xetq_submissions WHERE id=?', id); if (!s) throw notFound('XETQ topshiruvi');
    if (!['DRAFT', 'INTERNAL_REVIEW', 'REVISION_REQUIRED'].includes(s.status)) throw bad('Topshirilgan paketni tahrirlab bo‘lmaydi');
    const patch = {};
    if (input.documentIds) patch.document_ids = JSON.stringify(input.documentIds.map(Number).filter(Boolean));
    if (input.tsId !== undefined) patch.ts_id = V.optId(input.tsId, 'Texnik shart');
    if (input.packingSpec !== undefined) patch.packing_spec = V.str(input.packingSpec, 'Qadoqlash', { required: false, max: 3000 });
    if (input.logisticsInfo !== undefined) patch.logistics_info = V.str(input.logisticsInfo, 'Logistika', { required: false, max: 3000 });
    if (input.qty !== undefined) patch.qty = V.num(input.qty, 'Miqdor', { required: false, min: 0 });
    db.update('xetq_submissions', id, { ...patch, updated_at: clock.iso() });
    db.audit(user, 'XETQ_UPDATE', 'xetq_submissions', s.sub_no, Object.keys(patch));
    return { ok: true };
  });
}
function checklist(s) {
  const ts = s.ts_id ? db.get('SELECT * FROM technical_specifications WHERE id=?', s.ts_id) : null;
  const ids = JSON.parse(s.document_ids || '[]');
  const types = ids.length ? db.all(`SELECT doc_type, status FROM documents WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  return [
    { item: 'Texnik shart biriktirilgan', ok: !!ts, required: true },
    { item: 'Texnik shart tasdiqlangan', ok: ts?.status === 'APPROVED', required: true },
    { item: 'Kamida bitta hujjat biriktirilgan', ok: ids.length > 0, required: true },
    { item: 'Mas’ul xodim', ok: !!s.responsible_id, required: true },
    ...PACKAGE_TYPES.map((t) => ({ item: docs.DOC_TYPES[t], ok: types.some((x) => x.doc_type === t), required: false })),
    { item: 'Qadoqlash spetsifikatsiyasi', ok: !!s.packing_spec, required: false },
    { item: 'Logistika ma’lumoti', ok: !!s.logistics_info, required: false },
  ];
}
function transition(id, input, user) {
  return db.tx(() => {
    const s = db.get('SELECT * FROM xetq_submissions WHERE id=?', id); if (!s) throw notFound('XETQ topshiruvi');
    const to = V.oneOf(input.status, 'Holat', Object.keys(XETQ_FLOW));
    if (!XETQ_FLOW[s.status].includes(to)) throw bad(`${s.status} → ${to} o‘tish mumkin emas`);
    const patch = { status: to, updated_at: clock.iso() };
    const review = { submission_id: id, from_status: s.status, to_status: to, comment: V.str(input.comment, 'Izoh', { required: to === 'REVISION_REQUIRED', max: 3000 }), reviewer: input.reviewer || null, created_by: user?.id, created_at: clock.iso() };
    if (to === 'READY_FOR_SUBMISSION') {
      const miss = checklist(s).filter((c) => c.required && !c.ok);
      if (miss.length) throw bad(`Paket to‘liq emas: ${miss.map((m) => m.item).join(', ')}`);
    }
    if (to === 'SUBMITTED') {
      patch.submitted_at = clock.iso();
      const pkg = docs.generate('TECHNICAL_PACKAGE', 'xetq', id, user);
      const ids = JSON.parse(s.document_ids || '[]'); if (!ids.includes(pkg.id)) patch.document_ids = JSON.stringify([...ids, pkg.id]);
    }
    if (to === 'REVISION_REQUIRED') {
      review.required_changes = V.str(input.requiredChanges, 'Nima tuzatilishi kerak', { max: 3000 });
      review.fix_owner_id = V.id(input.fixOwnerId, 'Kim tuzatadi');
      review.deadline = V.date(input.deadline, 'Muddat');
    }
    if (s.status === 'REVISION_REQUIRED' && to === 'INTERNAL_REVIEW') {
      const nv = V.str(input.newVersion, 'Yangi versiya', { max: 10 });
      if (!/^\d+\.\d+$/.test(nv) || Number(nv) <= Number(s.version)) throw bad(`Yangi versiya ${s.version} dan katta bo‘lishi kerak (masalan ${docs.nextVersion(s.version)})`);
      patch.version = nv; review.new_version = nv;
      db.run("UPDATE ai_events SET status='RESOLVED', resolved_at=? WHERE dedupe_key LIKE ? AND status<>'RESOLVED'", clock.iso(), `xetq-rev-${id}-%`);
    }
    if (to === 'APPROVED') patch.approved_at = clock.iso();
    db.update('xetq_submissions', id, patch);
    db.insert('xetq_reviews', review);
    db.history('xetq', id, s.status, to, user, input.comment);
    db.audit(user, `XETQ_${to}`, 'xetq_submissions', s.sub_no, { comment: input.comment });
    if (to === 'SUBMITTED') db.emit('DOCUMENT_SUBMITTED', { id, subNo: s.sub_no });
    else if (to === 'APPROVED') db.emit('DOCUMENT_APPROVED', { kind: 'xetq', id, subNo: s.sub_no });
    else db.emit('XETQ_STATUS', { id, subNo: s.sub_no, status: to });
    return { status: to, version: patch.version || s.version };
  });
}

module.exports = { TS_FIELDS, XETQ_FLOW, PACKAGE_TYPES, createProject, createTS, reviseTS, setTSStatus, createSubmission, updateSubmission, transition, checklist };
