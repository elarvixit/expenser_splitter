/*
 * Splitter — minimal Supabase client. Calls the database functions defined in
 * supabase/schema.sql through Supabase's REST endpoint (/rest/v1/rpc/<fn>).
 * No SDK needed: the app only ever calls splitter_create_group, splitter_get_group and
 * splitter_save_group (prefixed so they can live next to another app in a shared project).
 */
(function (root) {
  'use strict';

  function createRemote(config) {
    if (!config || !config.supabaseUrl || !config.supabaseAnonKey) return null;
    const base = String(config.supabaseUrl).replace(/\/+$/, '') + '/rest/v1/rpc/';
    const key = String(config.supabaseAnonKey);
    const headers = { 'Content-Type': 'application/json', apikey: key };
    // Legacy anon keys are JWTs and go in Authorization too; new sb_publishable_ keys must not.
    if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key;

    async function rpc(fn, args) {
      const res = await fetch(base + fn, { method: 'POST', headers, body: JSON.stringify(args || {}) });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
      if (!res.ok) {
        const err = new Error((body && body.message) || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return body;
    }

    return {
      createGroup: (name) => rpc('splitter_create_group', { p_name: name }),
      getGroup: (token) => rpc('splitter_get_group', { p_token: token }),
      saveGroup: (token, version, group) => rpc('splitter_save_group', { p_token: token, p_version: version, p_group: group }),
    };
  }

  root.SplitterRemote = { createRemote };
})(typeof self !== 'undefined' ? self : this);
