// Unit tests for src/remote.js — the Supabase client (fetch is stubbed).
const test = require('node:test');
const assert = require('node:assert/strict');

global.self = global;
require('../../src/remote.js');
const { createRemote } = global.SplitterRemote;

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig';
let calls = [];
function stubFetch(status, body) {
  calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
}

test('no config, or a missing value → local-only mode (null)', () => {
  assert.equal(createRemote(null), null);
  assert.equal(createRemote({}), null);
  assert.equal(createRemote({ supabaseUrl: 'https://p.supabase.co' }), null);
  assert.equal(createRemote({ supabaseAnonKey: 'k' }), null);
});

test('project URL is accepted with or without trailing slash or /rest/v1', async () => {
  for (const url of ['https://p.supabase.co', 'https://p.supabase.co/', 'https://p.supabase.co/rest/v1', ' https://p.supabase.co/rest/v1/ ']) {
    stubFetch(200, null);
    await createRemote({ supabaseUrl: url, supabaseAnonKey: 'sb_publishable_x' }).whoami('s');
    assert.equal(calls[0].url, 'https://p.supabase.co/rest/v1/rpc/splitter_whoami', url);
  }
});

test('publishable keys go only in apikey; legacy JWT anon keys also in Authorization', async () => {
  stubFetch(200, null);
  await createRemote({ supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'sb_publishable_x' }).whoami('s');
  assert.equal(calls[0].init.headers.apikey, 'sb_publishable_x');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  stubFetch(200, null);
  await createRemote({ supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: JWT }).whoami('s');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${JWT}`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('every call maps to the right function with named arguments', async () => {
  const r = createRemote({ supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'k' });
  const cases = [
    [() => r.signUp('a@b.co', 'pw'), 'splitter_sign_up', { p_email: 'a@b.co', p_password: 'pw' }],
    [() => r.signIn('a@b.co', 'pw'), 'splitter_sign_in', { p_email: 'a@b.co', p_password: 'pw' }],
    [() => r.signOut('S'), 'splitter_sign_out', { p_session: 'S' }],
    [() => r.whoami('S'), 'splitter_whoami', { p_session: 'S' }],
    [() => r.changePassword('S', 'old', 'new'), 'splitter_change_password', { p_session: 'S', p_old: 'old', p_new: 'new' }],
    [() => r.listGroups('S'), 'splitter_list_groups', { p_session: 'S' }],
    [() => r.createGroup('S', 'Trip'), 'splitter_account_create_group', { p_session: 'S', p_name: 'Trip' }],
    [() => r.getGroup('S', 'T'), 'splitter_account_get_group', { p_session: 'S', p_token: 'T' }],
    [() => r.saveGroup('S', 'T', 3, { groupName: 'x' }), 'splitter_account_save_group', { p_session: 'S', p_token: 'T', p_version: 3, p_group: { groupName: 'x' } }],
    [() => r.deleteGroup('S', 'T'), 'splitter_account_delete_group', { p_session: 'S', p_token: 'T' }],
    [() => r.claimGroup('S', 'T'), 'splitter_account_claim_group', { p_session: 'S', p_token: 'T' }],
  ];
  for (const [call, fn, args] of cases) {
    stubFetch(200, true);
    await call();
    assert.equal(calls[0].url.split('/rpc/')[1], fn);
    assert.deepEqual(calls[0].body, args, fn);
  }
});

test('only deleteGroup uses keepalive (so it survives the page closing)', async () => {
  const r = createRemote({ supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'k' });
  stubFetch(200, true); await r.deleteGroup('S', 'T'); assert.equal(calls[0].init.keepalive, true);
  stubFetch(200, true); await r.saveGroup('S', 'T', 0, {}); assert.equal(calls[0].init.keepalive, false);
});

test('responses: JSON body returned, empty body → null', async () => {
  const r = createRemote({ supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'k' });
  stubFetch(200, { session: 'abc', email: 'a@b.co' });
  assert.deepEqual(await r.signIn('a@b.co', 'pw'), { session: 'abc', email: 'a@b.co' });
  stubFetch(200, '');
  assert.equal(await r.signOut('S'), null);
});

test('errors carry the server message and status; not_signed_in is flagged', async () => {
  const r = createRemote({ supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'k' });
  stubFetch(400, { code: 'P0001', message: 'version_conflict' });
  await assert.rejects(r.saveGroup('S', 'T', 0, {}), (e) => e.message === 'version_conflict' && e.status === 400 && !e.signedOut);
  stubFetch(400, { code: 'P0001', message: 'not_signed_in' });
  await assert.rejects(r.listGroups('bad'), (e) => e.signedOut === true);
  stubFetch(502, 'Bad gateway');
  await assert.rejects(r.listGroups('S'), (e) => e.message === 'Request failed (502)' && e.status === 502);
});
