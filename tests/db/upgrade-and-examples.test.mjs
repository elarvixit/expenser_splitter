// Upgrading an existing database, and the hand-run SQL in supabase/examples/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { freshDb, SCHEMA, read, group, eq, ROOT } from './helpers.mjs';

const Core = createRequire(import.meta.url)(ROOT + '/src/balances.js');
const V2 = read('tests/db/fixtures/schema-v2-share-links.sql');
const V3 = read('tests/db/fixtures/schema-v3-accounts.sql');

test('upgrade from share-links (v2): data kept, old anonymous functions removed, old group claimable once', async () => {
  const t = await freshDb(V2);
  await t.exec(`create table public.groups (id serial primary key, title text); insert into public.groups (title) values ('Team A');`); // a team app
  await t.asAnon();
  const legacy = await t.one(`select splitter_create_group('Hyderabad Weekend')`);
  await t.one('select splitter_save_group($1, 0, $2::jsonb)', [legacy, JSON.stringify(group('Hyderabad Weekend',
    [{ id: 'a', name: 'Akhil' }, { id: 't', name: 'Tarun' }], [eq('e1', 'a', 1001, ['a', 't'])]))]);
  await t.asAdmin();
  await t.exec(SCHEMA);
  await t.exec(SCHEMA);
  await t.asAnon();
  await assert.rejects(t.rows('select splitter_get_group($1)', [legacy]), /does not exist/, 'share-link reading is gone');
  const me = await t.signUp('me@x.com');
  const other = await t.signUp('other@x.com');
  assert.equal(await t.one('select splitter_account_claim_group($1, $2)', [me, legacy]), true);
  assert.equal(await t.one('select splitter_account_claim_group($1, $2)', [other, legacy]), false, 'only the first claim wins');
  const g = await t.one('select splitter_account_get_group($1, $2)', [me, legacy]);
  assert.equal(g.expenses[0].amount, 1001);
  await t.asAdmin();
  assert.equal(await t.one(`select title from public.groups`), 'Team A', "the team app's table is untouched");
});

test('upgrade from accounts (v3): accounts and groups kept, avatar column added', async () => {
  const t = await freshDb(V3);
  const s = await t.signUp('me@x.com');
  const token = await t.one(`select splitter_account_create_group($1, 'Trip')`, [s]);
  await t.one('select splitter_account_save_group($1, $2, 0, $3::jsonb)', [s, token, JSON.stringify(group('Trip', [{ id: 'a', name: 'Akhil' }]))]);
  await t.asAdmin();
  await t.exec(SCHEMA);
  await t.asAnon();
  assert.equal((await t.one('select splitter_whoami($1)', [s])).email, 'me@x.com', 'existing session still valid');
  const v = await t.one('select splitter_account_save_group($1, $2, 1, $3::jsonb)', [s, token, JSON.stringify(group('Trip', [{ id: 'a', name: 'Akhil', avatar: '🦁' }]))]);
  assert.equal(v, 2);
  assert.equal((await t.one('select splitter_account_get_group($1, $2)', [s, token])).members[0].avatar, '🦁');
});

test('examples/add-person.sql and add-expense.sql work and bump the version', async () => {
  const t = await freshDb(SCHEMA);
  const s = await t.signUp('me@x.com');
  const token = await t.one(`select splitter_account_create_group($1, 'Trip')`, [s]);
  await t.one('select splitter_account_save_group($1, $2, 0, $3::jsonb)', [s, token,
    JSON.stringify(group('Trip', [{ id: 'm_a', name: 'Asha' }, { id: 'm_b', name: 'Bilal' }, { id: 'm_c', name: 'Chen' }]))]);
  await t.asAdmin();
  await t.exec(read('supabase/examples/add-person.sql').split('YOUR-GROUP-TOKEN').join(token));
  const addExpense = read('supabase/examples/add-expense.sql').replace('YOUR-GROUP-TOKEN', token);
  await t.exec(addExpense);
  await t.asAnon();
  const g = await t.one('select splitter_account_get_group($1, $2)', [s, token]);
  assert.deepEqual(g.members.map((m) => m.name), ['Asha', 'Bilal', 'Chen', 'Ravi']);
  assert.equal(g.version, 3);
  assert.equal(g.expenses[0].category, 'Food');
  assert.deepEqual(g.expenses[0].splits.map((x) => x.amount), [15017, 15017, 15016]);
  assert.equal(Object.values(Core.calculateBalances(g).balances).reduce((a, b) => a + b, 0), 0);
  await t.asAdmin();
  await assert.rejects(t.exec(addExpense.replace("'Asha';", "'Zoe';")), /not in this group/, 'unknown payer: nothing saved');
  assert.equal(await t.one('select count(*)::int from tharun_expense_splitter_expenses'), 1);
});

test('examples/sample-groups.sql: three groups into the account, exact balances, re-run safe', async () => {
  const t = await freshDb(SCHEMA);
  const s = await t.signUp('Tharun@Example.com');
  await t.asAdmin();
  const sql = read('supabase/examples/sample-groups.sql').replace('YOUR-SPLITTER-EMAIL@example.com', ' tharun@example.com ');
  const result = await t.db.exec(sql);
  const table = result[result.length - 1].rows;
  assert.deepEqual(table.map((r) => [r.name, Number(r.people), Number(r.expenses), String(r.total_rupees)]).sort(), [
    ['College Outing — Wonderla', 6, 7, '13366.00'],
    ['Flat 302 · Monthly Bills', 4, 16, '149402.65'],
    ['Lonavala Trip', 8, 9, '74485.50'],
  ]);
  await t.db.exec(sql);
  assert.equal(await t.one('select count(*)::int from tharun_expense_splitter_groups'), 3, 'no duplicates on re-run');
  await t.asAnon();
  const list = await t.one('select splitter_list_groups($1)', [s]);
  for (const item of list) {
    const g = await t.one('select splitter_account_get_group($1, $2)', [s, item.token]);
    const { balances } = Core.calculateBalances(g);
    assert.equal(Object.values(balances).reduce((a, b) => a + b, 0), 0, item.name);
  }
  const lon = await t.one('select splitter_account_get_group($1, $2)', [s, list.find((g) => g.name === 'Lonavala Trip').token]);
  assert.equal(Core.calculateBalances(lon).balances.m_akhil, 1629555, 'Akhil gets back ₹16,295.55');
});

test('examples/sample-groups.sql with an unknown email: unowned groups with claim links', async () => {
  const t = await freshDb(SCHEMA);
  const result = await t.db.exec(read('supabase/examples/sample-groups.sql'));
  const table = result[result.length - 1].rows;
  assert.equal(table.length, 3);
  assert.ok(table.every((r) => r.owner.startsWith('(no owner yet') && /#g=[0-9a-f-]{36}$/.test(r.link)));
  const s = await t.signUp('someone@x.com');
  assert.equal(await t.one('select splitter_account_claim_group($1, $2)', [s, table[0].link.split('#g=')[1]]), true);
});
