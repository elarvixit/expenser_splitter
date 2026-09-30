// Test server for the browser tests: serves the site and a stand-in for Supabase.
// The database is a real Postgres (PGlite) running the real supabase/schema.sql, reached the way
// Supabase exposes it (POST /rest/v1/rpc/<fn> with named arguments), always as the anon role.
//   node tests/e2e/server.mjs [port]
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.argv[2] || process.env.PORT || 5180);

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec('create role anon; create role authenticated; create schema extensions;');
await db.exec(fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
await db.exec('set role anon');

// Like PostgREST: any splitter_* function, named arguments; objects are sent as JSON.
function callOf(fn, args) {
  const keys = Object.keys(args).filter((k) => /^p_\w+$/.test(k));
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  return [sql, keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))];
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.sql': 'text/plain; charset=utf-8', '.json': 'application/json',
};

let queue = Promise.resolve(); // PGlite runs one statement at a time; keep requests in order

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname);
  if (m) {
    let body = '';
    for await (const c of req) body += c;
    res.setHeader('Content-Type', 'application/json');
    if (!req.headers.apikey) { res.statusCode = 401; return res.end('{"message":"No API key found in request"}'); }
    if (!/^splitter_\w+$/.test(m[1]) || m[1].startsWith('splitter__')) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ code: 'PGRST202', message: `Could not find the function public.${m[1]}` }));
    }
    const run = queue.then(async () => {
      try {
        const [sql, params] = callOf(m[1], JSON.parse(body || '{}'));
        const r = await db.query(sql, params);
        res.end(JSON.stringify(r.rows[0].r));
      } catch (e) {
        res.statusCode = /does not exist/.test(e.message) ? 404 : 400;
        res.end(JSON.stringify({ code: e.code || 'P0001', message: e.message }));
      }
    });
    queue = run.catch(() => {});
    return run;
  }
  // Test-only hook (this server never runs in production): run SQL as the database owner,
  // e.g. to create a group from before accounts existed.
  if (url.pathname === '/__admin_sql' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const run = queue.then(async () => {
      try {
        await db.exec('reset role');
        const r = await db.query(body);
        res.end(JSON.stringify(r.rows));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ message: e.message }));
      } finally {
        await db.exec('set role anon');
      }
    });
    queue = run.catch(() => {});
    return run;
  }
  if (url.pathname === '/config.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.setHeader('Cache-Control', 'no-store');
    return res.end("window.SPLITTER_CONFIG = { supabaseUrl: location.origin, supabaseAnonKey: 'sb_publishable_test' };");
  }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
  if (!file.startsWith(ROOT) || file.includes('node_modules') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end('not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`splitter test server on http://localhost:${PORT}`));
