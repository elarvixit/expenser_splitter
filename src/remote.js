/*
 * Splitter — minimal Supabase client. Calls the database functions defined in
 * supabase/schema.sql through Supabase's REST endpoint (/rest/v1/rpc/<fn>).
 * No SDK needed. Splitter has its own accounts (not Supabase Auth): signing in
 * returns a session token that every group call passes along.
 */
(function (root) {
  'use strict';

  function createRemote(config) {
    if (!config || !config.supabaseUrl || !config.supabaseAnonKey) return null;
    // Accept the project URL with or without a trailing /rest/v1 (a common copy-paste).
    const base = String(config.supabaseUrl).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '') + '/rest/v1/rpc/';
    const key = String(config.supabaseAnonKey).trim();
    const headers = { 'Content-Type': 'application/json', apikey: key };
    // Legacy anon keys are JWTs and go in Authorization too; new sb_publishable_ keys must not.
    if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key;

    async function rpc(fn, args, opts) {
      const res = await fetch(base + fn, { method: 'POST', headers, body: JSON.stringify(args || {}), keepalive: !!(opts && opts.keepalive) });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
      if (!res.ok) {
        const err = new Error((body && body.message) || `Request failed (${res.status})`);
        err.status = res.status;
        if (/not_signed_in/.test(err.message)) err.signedOut = true;
        throw err;
      }
      return body;
    }

    return {
      // accounts — sign up / in return { session, email } or { error }
      signUp: (email, password) => rpc('splitter_sign_up', { p_email: email, p_password: password }),
      signIn: (email, password) => rpc('splitter_sign_in', { p_email: email, p_password: password }),
      signOut: (session) => rpc('splitter_sign_out', { p_session: session }),
      whoami: (session) => rpc('splitter_whoami', { p_session: session }),
      changePassword: (session, oldPw, newPw) =>
        rpc('splitter_change_password', { p_session: session, p_old: oldPw, p_new: newPw }),
      // groups — only ever the signed-in account's own
      listGroups: (session) => rpc('splitter_list_groups', { p_session: session }),
      createGroup: (session, name) => rpc('splitter_account_create_group', { p_session: session, p_name: name }),
      getGroup: (session, token) => rpc('splitter_account_get_group', { p_session: session, p_token: token }),
      saveGroup: (session, token, version, group) =>
        rpc('splitter_account_save_group', { p_session: session, p_token: token, p_version: version, p_group: group }),
      // keepalive: a delete fired as the page closes still reaches the server
      deleteGroup: (session, token) => rpc('splitter_account_delete_group', { p_session: session, p_token: token }, { keepalive: true }),
      claimGroup: (session, token) => rpc('splitter_account_claim_group', { p_session: session, p_token: token }),
    };
  }

  root.SplitterRemote = { createRemote };
})(typeof self !== 'undefined' ? self : this);
