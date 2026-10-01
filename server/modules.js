'use strict';
// Yoqib-o‘chiriladigan modullar. Logistika (jo‘natma, transport, yuklash, haydovchilar, AI dispetcher, jo‘natma hisobotlari)
// standart holatda o‘chiq va saytda umuman ko‘rinmaydi; super admin Sozlamalardan yoqishi mumkin.
const db = require('./db');

const logisticsOn = () => process.env.LOGISTICS_MODULE === '1' || db.setting('module_logistics', false) === true;
const modules = () => ({ logistics: logisticsOn() });
const LOGI_DOCS = ['DELIVERY_NOTE', 'LOADING_SHEET', 'SHIPMENT_RECORD', 'TRANSPORT_ASSIGNMENT', 'LOGISTICS_SPEC'];
const LOGI_REPORTS = ['logistics', 'loading'];
const LOGI_PERMS = ['dispatch.manage', 'transport.manage', 'loading', 'shipments.manage'];
const LOGI_ENTITIES = ['shipments', 'vehicles', 'drivers', 'dispatch_jobs', 'loading_tasks', 'loadings'];
/** Logistika o‘chiq bo‘lsa — logistika foydalanuvchisi (rol yoki bo‘lim)mi. */
const isLogiUser = (u) => u.role_code === 'LOGISTICS' || u.section === 'LOGISTIKA';
/** Logistika o‘chiq bo‘lsa — audit yozuvi logistikaga tegishlimi. */
const isLogiAudit = (a) => LOGI_ENTITIES.includes(a.entity) || /DISPATCH|SHIPMENT|TRANSPORT|VEHICLE|DRIVER|LOADING/.test(a.action || '') || /LOGISTIKA|"shipment"/.test(a.details || '') || a.username === 'ai.dispetcher';
/** Logistika o‘chiq bo‘lsa — ro‘yxatlardan logistika bandlarini olib tashlaydi. */
const without = (obj, keys) => (logisticsOn() ? obj : Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k))));

module.exports = { logisticsOn, modules, without, LOGI_DOCS, LOGI_REPORTS, LOGI_PERMS, isLogiUser, isLogiAudit };
