// Shared setup for database tests: a Supabase-like Postgres (PGlite) with the real schema.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
export const SCHEMA = read('supabase/schema.sql');

/** A fresh database with Supabase's roles and extensions schema; optionally run SQL files first. */
export async function freshDb(...sqlFiles) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec('create role anon; create role authenticated; create schema extensions;');
  for (const sql of sqlFiles) await db.exec(sql);
  const api = {
    db,
    rows: async (sql, params = []) => (await db.query(sql, params)).rows,
    one: async (sql, params) => Object.values((await db.query(sql, params)).rows[0])[0],
    exec: (sql) => db.exec(sql),
    asAnon: () => db.exec('set role anon'),
    asAdmin: () => db.exec('reset role'),
    /** Sign up as anon and return the session token. */
    async signUp(email, password = 'password 1') {
      await api.asAnon();
      const r = await api.one('select splitter_sign_up($1, $2)', [email, password]);
      return r.session;
    },
  };
  return api;
}

export const group = (name, members, expenses = [], settlements = []) => ({ groupName: name, members, expenses, settlements });
export const eq = (id, paidBy, amount, ids, extra = {}) => {
  const n = ids.length;
  const base = Math.floor(amount / n);
  return Object.assign({ id, description: id, paidBy, amount, splitMode: 'equal', splitInput: {}, createdAt: '2026-09-01T10:00:00Z',
    splits: ids.map((m, i) => ({ memberId: m, amount: base + (i < amount % n ? 1 : 0) })) }, extra);
};
