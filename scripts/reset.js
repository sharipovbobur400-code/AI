'use strict';
// Deletes the local database so the next start re-seeds it. Backups are kept.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '..', process.env.DATA_DIR || 'data');
for (const f of ['wms.db', 'wms.db-wal', 'wms.db-shm']) { const p = path.join(dir, f); if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('o‘chirildi:', p); } }
console.log('Keyingi "npm start" bazani qayta yaratadi.');
