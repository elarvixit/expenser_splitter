// Database tests for supabase/schema.sql: accounts, privacy, validation, conflicts, avatars, security.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, SCHEMA, group, eq } from './helpers.mjs';

// A fresh copy every time, so one test's mutations can't leak into the next.
const body = () => group('Flat', [{ id: 'a', name: 'Asha' }, { id: 'b', name: 'Bilal' }],
  [eq('e1', 'a', 1001, ['a', 'b'], { category: 'Bills' })], []);

test('schema installs, and re-running it is safe', async () => {
  const t = await freshDb(SCHEMA, SCHEMA);
  const tables = await t.rows(`select table_name from information_schema.tables where table_schema='public' and table_name like 'tharun_expense_splitter%' order by 1`);
  assert.deepEqual(tables.map((r) => r.table_name.replace('tharun_expense_splitter_', '')),
    ['expense_splits', 'expenses', 'groups', 'members', 'sessions', 'settlements', 'users']);
});

test('sign up: email normalised, 64-char session, validation errors returned', async () => {
  const t = await freshDb(SCHEMA);
  await t.asAnon();
  const r = await t.one(`select splitter_sign_up('  Tharun@Example.COM ', 'correct horse')`);
  assert.equal(r.email, 'tharun@example.com');
  assert.match(r.session, /^[0-9a-f]{64}$/);
  assert.equal((await t.one(`select splitter_sign_up('tharun@example.com', 'another one')`)).error, 'email_taken');
  assert.equal((await t.one(`select splitter_sign_up('not-an-email', 'longenough')`)).error, 'invalid_email');
  assert.equal((await t.one(`select splitter_sign_up('a@b.co', 'short')`)).error, 'weak_password');
  assert.equal((await t.one(`select splitter_sign_up('a@b.co', $1)`, ['x'.repeat(73)])).error, 'weak_password', 'bcrypt 72-byte limit');
});

test('sign in: right/wrong password, same error for unknown email, whoami, sign out', async () => {
  const t = await freshDb(SCHEMA);
  await t.signUp('t@x.com', 'correct horse');
  assert.equal((await t.one(`select splitter_sign_in('t@x.com', 'wrong')`)).error, 'invalid_credentials');
  assert.equal((await t.one(`select splitter_sign_in('nobody@x.com', 'whatever1')`)).error, 'invalid_credentials');
  const s = (await t.one(`select splitter_sign_in('T@X.com', 'correct horse')`)).session;
  assert.equal((await t.one('select splitter_whoami($1)', [s])).email, 't@x.com');
  await t.one('select splitter_sign_out($1)', [s]);
  await assert.rejects(t.one('select splitter_whoami($1)', [s]), /not_signed_in/);
  await assert.rejects(t.one(`select splitter_whoami('garbage')`), /not_signed_in/);
});

test('five wrong passwords lock the account for 15 minutes (even the right password)', async () => {
  const t = await freshDb(SCHEMA);
  await t.signUp('t@x.com', 'correct horse');
  for (let i = 0; i < 4; i++) assert.equal((await t.one(`select splitter_sign_in('t@x.com', 'nope')`)).error, 'invalid_credentials');
  await t.one(`select splitter_sign_in('t@x.com', 'nope')`);
  const locked = await t.one(`select splitter_sign_in('t@x.com', 'correct horse')`);
  assert.equal(locked.error, 'account_locked');
  assert.ok(locked.retryAfter);
  await t.asAdmin();
  await t.exec(`update tharun_expense_splitter_users set locked_until = now() - interval '1 second'`);
  await t.asAnon();
  assert.ok((await t.one(`select splitter_sign_in('t@x.com', 'correct horse')`)).session, 'unlocks after the lock expires');
});

test('passwords and sessions are stored only as hashes', async () => {
  const t = await freshDb(SCHEMA);
  const s = await t.signUp('t@x.com', 'correct horse');
  await t.asAdmin();
  const u = (await t.rows(`select password_hash from tharun_expense_splitter_users`))[0];
  assert.match(u.password_hash, /^\$2a\$10\$/);
  assert.equal(await t.one(`select count(*)::int from tharun_expense_splitter_sessions where token_hash = $1`, [s]), 0);
  assert.equal(await t.one(`select count(*)::int from tharun_expense_splitter_sessions where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')`, [s]), 1);
});

test('change password: needs the old one, signs out other devices, keeps this one', async () => {
  const t = await freshDb(SCHEMA);
  const s1 = await t.signUp('t@x.com', 'correct horse');
  const s2 = (await t.one(`select splitter_sign_in('t@x.com', 'correct horse')`)).session;
  assert.equal((await t.one(`select splitter_change_password($1, 'wrong', 'new password')`, [s1])).error, 'invalid_credentials');
  assert.equal((await t.one(`select splitter_change_password($1, 'correct horse', 'short')`, [s1])).error, 'weak_password');
  assert.equal((await t.one(`select splitter_change_password($1, 'correct horse', 'new password')`, [s1])).ok, true);
  await assert.rejects(t.one('select splitter_whoami($1)', [s2]), /not_signed_in/);
  assert.equal((await t.one('select splitter_whoami($1)', [s1])).email, 't@x.com');
  assert.ok((await t.one(`select splitter_sign_in('t@x.com', 'new password')`)).session);
});

test('groups: create, save, read back, list — with category round-trip', async () => {
  const t = await freshDb(SCHEMA);
  const s = await t.signUp('t@x.com');
  const token = await t.one(`select splitter_account_create_group($1, '  Flat  ')`, [s]);
  assert.equal(await t.one(`select splitter_account_save_group($1, $2, 0, $3::jsonb)`, [s, token, JSON.stringify(body())]), 1);
  const g = await t.one(`select splitter_account_get_group($1, $2)`, [s, token]);
  assert.equal(g.groupName, 'Flat');
  assert.equal(g.version, 1);
  assert.deepEqual(g.members.map((m) => m.name), ['Asha', 'Bilal']);
  assert.equal(g.expenses[0].category, 'Bills');
  assert.deepEqual(g.expenses[0].splits.map((x) => x.amount), [501, 500]);
  const list = await t.one('select splitter_list_groups($1)', [s]);
  assert.deepEqual(list.map((x) => [x.name, x.version]), [['Flat', 1]]);
});

test('privacy: another account cannot read, save, delete or claim your group', async () => {
  const t = await freshDb(SCHEMA);
  const mine = await t.signUp('me@x.com');
  const theirs = await t.signUp('them@x.com');
  const token = await t.one(`select splitter_account_create_group($1, 'Private')`, [mine]);
  assert.equal(await t.one('select splitter_account_get_group($1, $2)', [theirs, token]), null);
  await assert.rejects(t.one('select splitter_account_save_group($1, $2, 0, $3::jsonb)', [theirs, token, JSON.stringify(body())]), /group_not_found/);
  assert.equal(await t.one('select splitter_account_delete_group($1, $2)', [theirs, token]), false);
  assert.equal(await t.one('select splitter_account_claim_group($1, $2)', [theirs, token]), false);
  assert.equal((await t.one('select splitter_list_groups($1)', [theirs])).length, 0);
  assert.equal(await t.one('select splitter_account_delete_group($1, $2)', [mine, token]), true, 'owner can delete');
});

test('the database enforces the ledger rules even if a client is wrong', async () => {
  const t = await freshDb(SCHEMA);
  const s = await t.signUp('t@x.com');
  const token = await t.one(`select splitter_account_create_group($1, 'G')`, [s]);
  const save = (b) => t.one('select splitter_account_save_group($1, $2, 0, $3::jsonb)', [s, token, JSON.stringify(b)]);
  const bad = (mutate) => { const b = body(); mutate(b); return save(b); };
  await assert.rejects(bad((b) => { b.expenses[0].splits[0].amount = 500; }), /splits_mismatch/, 'splits must sum');
  await assert.rejects(bad((b) => { b.expenses[0].amount = 0; b.expenses[0].splits = []; }), /check/, 'zero amount');
  await assert.rejects(bad((b) => { b.expenses[0].amount = 10.5; b.expenses[0].splits = [{ memberId: 'a', amount: 10.5 }]; }), /bigint/, 'fractional paise');
  await assert.rejects(bad((b) => { b.expenses[0].paidBy = 'zzz'; }), /foreign key/, 'unknown payer');
  await assert.rejects(bad((b) => { b.members.push({ id: 'c', name: 'asha' }); }), /unique/, 'duplicate name (any case)');
  await assert.rejects(bad((b) => { b.settlements = [{ id: 's', from: 'a', to: 'a', amount: 5, createdAt: '2026-09-01T00:00:00Z' }]; }), /check/, 'payment to self');
  await assert.rejects(bad((b) => { b.settlements = [{ id: 's', from: 'a', to: 'b', amount: -5, createdAt: '2026-09-01T00:00:00Z' }]; }), /check/, 'negative payment');
  await assert.rejects(bad((b) => { b.expenses[0].category = 'x'.repeat(25); }), /check/, 'category max 24');
  await assert.rejects(bad((b) => { b.members = Array.from({ length: 51 }, (_, i) => ({ id: 'm' + i, name: 'M' + i })); b.expenses = []; }), /group_too_large/);
  assert.equal((await t.one('select splitter_account_get_group($1, $2)', [s, token])).version, 0, 'nothing was saved by failed attempts');
});

test('optimistic concurrency: a stale version is refused with version_conflict', async () => {
  const t = await freshDb(SCHEMA);
  const s = await t.signUp('t@x.com');
  const token = await t.one(`select splitter_account_create_group($1, 'G')`, [s]);
  await t.one('select splitter_account_save_group($1, $2, 0, $3::jsonb)', [s, token, JSON.stringify(body())]);
  await assert.rejects(t.one('select splitter_account_save_group($1, $2, 0, $3::jsonb)', [s, token, JSON.stringify(body())]), /version_conflict/);
  assert.equal(await t.one('select splitter_account_save_group($1, $2, 1, $3::jsonb)', [s, token, JSON.stringify(body())]), 2);
});

test('avatars: emoji and small photos accepted; HTML, SVG and oversized images refused', async () => {
  const t = await freshDb(SCHEMA);
  const s = await t.signUp('t@x.com');
  const token = await t.one(`select splitter_account_create_group($1, 'G')`, [s]);
  const photo = 'data:image/jpeg;base64,' + Buffer.alloc(3000, 7).toString('base64');
  const withAvatars = (a, b) => group('G', [{ id: 'a', name: 'Asha', avatar: a }, { id: 'b', name: 'Bilal', avatar: b }]);
  let v = await t.one('select splitter_account_save_group($1, $2, 0, $3::jsonb)', [s, token, JSON.stringify(withAvatars('🦁', photo))]);
  const g = await t.one('select splitter_account_get_group($1, $2)', [s, token]);
  assert.equal(g.members[0].avatar, '🦁');
  assert.equal(g.members[1].avatar, photo);
  for (const evil of ['<script>', 'javascript:alert(1)//', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,' + 'A'.repeat(17000)]) {
    await assert.rejects(t.one('select splitter_account_save_group($1, $2, $3, $4::jsonb)', [s, token, v, JSON.stringify(withAvatars(evil, null))]), /check/, evil.slice(0, 20));
  }
  v = await t.one('select splitter_account_save_group($1, $2, $3, $4::jsonb)', [s, token, v, JSON.stringify(withAvatars(null, null))]);
  const cleared = await t.one('select splitter_account_get_group($1, $2)', [s, token]);
  assert.ok(!('avatar' in cleared.members[0]), 'removing an avatar clears it');
});

test('the public key can only call the public functions — no tables, no internal helpers', async () => {
  const t = await freshDb(SCHEMA);
  await t.asAnon();
  for (const table of ['users', 'sessions', 'groups', 'members', 'expenses', 'expense_splits', 'settlements']) {
    await assert.rejects(t.rows(`select * from tharun_expense_splitter_${table}`), /permission denied/, table);
  }
  await assert.rejects(t.rows(`insert into tharun_expense_splitter_groups (name) values ('x')`), /permission denied/);
  await assert.rejects(t.rows(`select splitter__group_json(gen_random_uuid())`), /permission denied/);
  await assert.rejects(t.rows(`select splitter__save(gen_random_uuid(), 0, '{}')`), /permission denied/);
  await assert.rejects(t.rows(`select splitter__session_user('x')`), /permission denied/);
});

test('deleting an account deletes its groups and everything in them', async () => {
  const t = await freshDb(SCHEMA);
  const s = await t.signUp('t@x.com');
  const token = await t.one(`select splitter_account_create_group($1, 'G')`, [s]);
  await t.one('select splitter_account_save_group($1, $2, 0, $3::jsonb)', [s, token, JSON.stringify(body())]);
  await t.asAdmin();
  await t.exec(`delete from tharun_expense_splitter_users where email = 't@x.com'`);
  for (const table of ['groups', 'members', 'expenses', 'expense_splits', 'sessions']) {
    assert.equal(await t.one(`select count(*)::int from tharun_expense_splitter_${table}`), 0, table);
  }
});

test('password reset from the file header works and unlocks the account', async () => {
  const t = await freshDb(SCHEMA);
  await t.signUp('bob@x.com', 'old password');
  for (let i = 0; i < 5; i++) await t.one(`select splitter_sign_in('bob@x.com', 'nope')`);
  await t.asAdmin();
  const header = SCHEMA.split('\n').filter((l) => l.startsWith('--   ')).map((l) => l.slice(5)).join('\n');
  const reset = header.slice(header.indexOf('update tharun_expense_splitter_users'), header.indexOf('\n\n', header.indexOf('delete from tharun_expense_splitter_sessions')));
  await t.exec(reset.split('\n').filter((l) => !l.startsWith('To remove')).join('\n')
    .replace('NEW-PASSWORD-HERE', 'reset pass 99').split("person@example.com").join('bob@x.com').split('\ndrop')[0]);
  await t.asAnon();
  assert.ok((await t.one(`select splitter_sign_in('bob@x.com', 'reset pass 99')`)).session);
});
