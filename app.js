'use strict';
// Universal entry point — hosting panels (ISPmanager, cPanel "Node.js App", Passenger) usually start app.js.
// Picks the right SQLite for the installed Node version, then starts server/server.js.
const path = require('node:path');

let builtinSqlite = true;
try { require('node:sqlite'); } catch { builtinSqlite = false; }

const [major, minor] = process.versions.node.split('.').map(Number);
const flagSupported = major > 22 || (major === 22 && minor >= 5);

if (!builtinSqlite && flagSupported && !process.env.__WMS_CHILD) {
  // Node 22.5–22.12: node:sqlite exists but needs --experimental-sqlite
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', path.join(__dirname, 'server', 'server.js')], { stdio: 'inherit', env: { ...process.env, __WMS_CHILD: '1' } });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  // Node 22.13+ (built-in SQLite) or older Node with the better-sqlite3 package installed
  require('./server/server.js');
}
