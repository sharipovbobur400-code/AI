'use strict';
// Durable storage for the SQLite database when running serverless (Vercel).
// The whole DB is kept as one gzip snapshot + a version id; a lock row serialises writers across instances.
//   • postgres — Neon / Vercel Postgres (DATABASE_URL or POSTGRES_URL)
//   • dir:<path> — a shared folder (automated tests / self-hosted experiments)
const fs = require('node:fs');
const path = require('node:path');

function pgStore(url) {
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(url);
  return {
    name: 'postgres',
    async init() {
      await sql`CREATE TABLE IF NOT EXISTS wms_snapshot (id int PRIMARY KEY, version text NOT NULL, data bytea NOT NULL, size int, updated_at timestamptz DEFAULT now())`;
      await sql`CREATE TABLE IF NOT EXISTS wms_lock (id int PRIMARY KEY, owner text, until timestamptz)`;
      await sql`INSERT INTO wms_lock (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
    },
    async version() { const r = await sql`SELECT version FROM wms_snapshot WHERE id = 1`; return r[0] ? r[0].version : null; },
    async download() {
      const r = await sql`SELECT version, encode(data, 'base64') AS b64 FROM wms_snapshot WHERE id = 1`;
      return r[0] ? { version: r[0].version, data: Buffer.from(r[0].b64, 'base64') } : null;
    },
    async upload(buf, version) {
      await sql`INSERT INTO wms_snapshot (id, version, data, size, updated_at) VALUES (1, ${version}, decode(${buf.toString('base64')}, 'base64'), ${buf.length}, now())
        ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data, size = EXCLUDED.size, updated_at = now()`;
    },
    async tryLock(owner, ttlSec) {
      const r = await sql`UPDATE wms_lock SET owner = ${owner}, until = now() + (${`${ttlSec} seconds`})::interval WHERE id = 1 AND (owner IS NULL OR until < now()) RETURNING owner`;
      return r.length === 1;
    },
    async unlock(owner) { await sql`UPDATE wms_lock SET owner = NULL, until = NULL WHERE id = 1 AND owner = ${owner}`; },
  };
}

function dirStore(dir) {
  const f = (n) => path.join(dir, n);
  return {
    name: `dir:${dir}`,
    async init() { fs.mkdirSync(dir, { recursive: true }); },
    async version() { try { return fs.readFileSync(f('version'), 'utf8') || null; } catch { return null; } },
    async download() {
      const version = await this.version(); if (!version) return null;
      return { version, data: fs.readFileSync(f(`db-${version}.gz`)) };
    },
    async upload(buf, version) {
      fs.writeFileSync(f(`db-${version}.gz`), buf);
      const prev = await this.version();
      fs.writeFileSync(f('version.tmp'), version); fs.renameSync(f('version.tmp'), f('version'));
      if (prev && prev !== version) setTimeout(() => { try { fs.unlinkSync(f(`db-${prev}.gz`)); } catch { /* reader may still hold it */ } }, 5000).unref();
    },
    async tryLock(owner, ttlSec) {
      const lock = f('lock');
      try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner'), owner); return true; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > ttlSec * 1000) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ }
        return false;
      }
    },
    async unlock(owner) {
      const lock = f('lock');
      try { if (fs.readFileSync(path.join(lock, 'owner'), 'utf8') === owner) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* not ours / gone */ }
    },
  };
}

/** Postgres manzili: DATABASE_URL / POSTGRES_URL, yoki Vercel–Neon prefiksli nomlar (masalan STORAGE_DATABASE_URL, AI_POSTGRES_URL). */
function databaseUrl(env = process.env) {
  const isPg = (v) => typeof v === 'string' && /^postgres(ql)?:\/\//i.test(v.trim());
  for (const k of ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL']) if (isPg(env[k])) return env[k].trim();
  const keys = Object.keys(env).filter((k) => isPg(env[k]));
  // pooled ulanish afzal (UNPOOLED / NON_POOLING emas), keyin *_DATABASE_URL, *_POSTGRES_URL
  const rank = (k) => (/UNPOOLED|NON_POOLING|NO_SSL/.test(k) ? 10 : 0) + (/DATABASE_URL$/.test(k) ? 0 : /POSTGRES_URL$/.test(k) ? 1 : 2);
  keys.sort((a, b) => rank(a) - rank(b));
  return keys[0] ? env[keys[0]].trim() : null;
}

function createStore() {
  const s = process.env.WMS_SNAPSHOT_STORE;
  if (s && s.startsWith('dir:')) return dirStore(s.slice(4));
  const url = databaseUrl();
  return url ? pgStore(url) : null;
}
module.exports = { createStore, pgStore, dirStore, databaseUrl };
