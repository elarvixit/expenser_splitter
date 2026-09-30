/*
 * Splitter — UI layer. Each group stores only its transactions (members,
 * expenses, settlements). Every render recomputes the active group's balances
 * with SplitCore.calculateBalances.
 */
(function () {
  'use strict';

  const {
    calculateBalances,
    suggestSettlements,
    splitEqually,
    splitByPercentage,
    splitExact,
    parseRupees,
    formatPaise,
    ValidationError,
  } = window.SplitCore;
  const Cat = window.SplitCategories;
  const UI = window.SplitUI;

  const STORE_KEY = 'splitter:v2';
  const LEGACY_KEY = 'halve:v1'; // single-group data from the first version
  const SESSION_KEY = 'splitter:session';
  const $ = (sel) => document.querySelector(sel);
  // null when config.js has no Supabase settings → local-only mode (no accounts)
  const remote = window.SplitterRemote ? window.SplitterRemote.createRemote(window.SPLITTER_CONFIG) : null;

  // ---------- account ----------
  // Splitter has its own accounts (email + password). Signed out, groups live only on this
  // device; signed in, they sync to the account and each user sees only their own groups.

  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      return s && typeof s.token === 'string' && typeof s.email === 'string' ? s : null;
    } catch (_) {
      return null;
    }
  }

  function saveSession() {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch (_) { /* storage unavailable */ }
  }

  let session = remote ? loadSession() : null; // { token, email } or null
  const canSync = () => !!(remote && session);

  // ---------- state ----------
  // store = { account, activeGroupId, groups: [group] }   (account = signed-in email, or null)
  // group = { id, groupName, members, expenses, settlements, createdAt,
  //           token     – the group's id in Supabase once uploaded (else null)
  //           owned     – the server confirmed this account owns it
  //           version   – server version this copy is based on
  //           rev       – local change counter; synced when rev === syncedRev }

  function newGroup(name) {
    return {
      id: uid('g'), groupName: name || 'New group', members: [], expenses: [], settlements: [],
      createdAt: new Date().toISOString(), token: null, owned: false, version: 0, rev: 0, syncedRev: 0,
    };
  }

  function normalizeGroup(g) {
    g.token = g.token || null;
    g.owned = !!g.owned;
    g.version = Number.isInteger(g.version) ? g.version : 0;
    g.rev = Number.isInteger(g.rev) ? g.rev : 0;
    g.syncedRev = Number.isInteger(g.syncedRev) ? g.syncedRev : g.rev;
    delete g.loading;
    return g;
  }

  const hasContent = (g) => g.members.length > 0 || g.expenses.length > 0 || g.settlements.length > 0;
  const needsSync = (g) => g.rev !== g.syncedRev || (!g.token && hasContent(g)) || (!!g.token && !g.owned);

  function isValidGroup(g) {
    try {
      return !!g && typeof g.id === 'string' && Array.isArray(g.members) && Array.isArray(g.expenses) &&
        Array.isArray(g.settlements) && !!calculateBalances(g); // rejects corrupted ledgers
    } catch (_) {
      return false;
    }
  }

  function freshStore(account) {
    const g = newGroup('My group');
    return { account: account || null, activeGroupId: g.id, groups: [g] };
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        const account = (s && s.account) || null;
        // Another account's cached groups (or a session that ended) never show on this device.
        if (account && (!session || session.email !== account)) return freshStore(session && session.email);
        const groups = (s && Array.isArray(s.groups) ? s.groups : []).filter(isValidGroup).map(normalizeGroup);
        if (groups.length) {
          const active = groups.some((g) => g.id === s.activeGroupId) ? s.activeGroupId : groups[0].id;
          return { account, activeGroupId: active, groups };
        }
      }
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const g = normalizeGroup(Object.assign(newGroup(), JSON.parse(legacy)));
        if (isValidGroup(g)) return { account: null, activeGroupId: g.id, groups: [g] };
      }
    } catch (_) { /* fall through to a fresh store */ }
    return freshStore(null);
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_) { /* storage unavailable */ }
  }

  let store = loadStore();
  let state = store.groups.find((g) => g.id === store.activeGroupId); // the active group

  /** Apply a change to a copy of a group; only keep it if the ledger is still valid. */
  function commit(mutate, groupId = state.id) {
    const quiet = quietCommit; // read and clear first, so a failed change can't leave it set
    quietCommit = false;
    const i = store.groups.findIndex((g) => g.id === groupId);
    if (i < 0) return;
    const next = JSON.parse(JSON.stringify(store.groups[i]));
    mutate(next);
    calculateBalances(next); // throws ValidationError if the change breaks the ledger
    next.rev += 1;
    store.groups[i] = next;
    if (next.id === state.id) state = next;
    save();
    celebrateNext = next.id === state.id && !quiet;
    render();
    if (canSync()) {
      pendingOps(next.id).push({ rev: next.rev, mutate }); // kept so it can be replayed on a conflict
      sync(next.id);
    }
  }

  function switchGroup(id) {
    const g = store.groups.find((x) => x.id === id);
    if (!g) return;
    store.activeGroupId = id;
    state = g;
    spendMonth = null; // the day-by-day view belongs to the group it was opened in
    save();
    render();
    updateHash();
    pull(id);
  }

  const findGroup = (id) => store.groups.find((g) => g.id === id);

  /** Replace a group object in the store (keeps `state` pointing at the active group). */
  function putGroup(next) {
    const i = store.groups.findIndex((g) => g.id === next.id);
    if (i < 0) return;
    store.groups[i] = next;
    if (state.id === next.id) state = next;
    save();
  }

  // ---------- Supabase sync ----------
  // Every change is applied locally first, then pushed with save_group(session, token, version, group).
  // If another device saved in between, the server answers 'version_conflict': we fetch the
  // latest copy, replay our not-yet-saved changes on top of it and try again.

  const ops = new Map(); // groupId → [{ rev, mutate }] not yet confirmed by the server
  const inflight = new Map(); // groupId → promise of the running sync (syncs are serialized)
  const pendingDeletes = new Map(); // groupId → timer for a server delete that can still be undone
  let offline = false;

  function pendingOps(id) {
    if (!ops.has(id)) ops.set(id, []);
    return ops.get(id);
  }

  const payloadOf = (g) => ({ groupName: g.groupName, members: g.members, expenses: g.expenses, settlements: g.settlements });

  function fromServer(local, server) {
    const next = Object.assign({}, local, {
      groupName: server.groupName,
      members: server.members,
      expenses: server.expenses,
      settlements: server.settlements,
      version: server.version,
      owned: true,
    });
    delete next.loading;
    calculateBalances(next); // never accept a ledger the engine rejects
    return next;
  }

  function sync(id, opts) {
    if (!canSync()) return Promise.resolve();
    const run = (inflight.get(id) || Promise.resolve())
      .then(() => pushGroup(id, opts || {}))
      .then(() => { offline = false; })
      .catch((err) => {
        if (err && err.signedOut) return handleSignedOut();
        offline = true;
        console.warn('Splitter sync failed; will retry', err);
      })
      .finally(() => {
        if (inflight.get(id) === run) inflight.delete(id);
        renderSyncStatus();
      });
    inflight.set(id, run);
    renderSyncStatus();
    return run;
  }

  async function pushGroup(id, { force = false }) {
    for (let guard = 0; guard < 8; guard++) {
      if (!canSync()) return;
      let g = findGroup(id);
      if (!g || g.loading || pendingDeletes.has(id)) return;
      if (!g.token) {
        if (!force && !hasContent(g)) return; // don't create empty groups on the server
        const token = await remote.createGroup(session.token, g.groupName);
        g = findGroup(id);
        if (!g) return;
        putGroup(Object.assign({}, g, { token, owned: true, version: 0, syncedRev: -1 })); // -1 → must save contents
        if (id === state.id) updateHash();
        continue;
      }
      if (!g.owned) {
        // A group from before accounts (or from another device): move it into this account.
        const mine = await remote.claimGroup(session.token, g.token);
        g = findGroup(id);
        if (!g) return;
        // Someone else already owns it: keep this device's copy as a new group of our own.
        putGroup(Object.assign({}, g, mine ? { owned: true } : { token: null, version: 0, syncedRev: -1 }));
        continue;
      }
      if (g.rev === g.syncedRev) return;
      const sentRev = g.rev;
      try {
        const version = await remote.saveGroup(session.token, g.token, g.version, payloadOf(g));
        const latest = findGroup(id);
        if (!latest) return;
        putGroup(Object.assign({}, latest, { version, syncedRev: sentRev }));
        ops.set(id, pendingOps(id).filter((op) => op.rev > sentRev));
      } catch (err) {
        if (err.signedOut) throw err;
        if (/version_conflict/.test(err.message)) await rebase(id);
        else if (err.status === 400 || err.status === 409) await discardRejected(id, err);
        else throw err; // network / server trouble → retried later
      }
    }
  }

  /** The server refused our copy (e.g. a duplicate name added at the same time on another device). */
  async function discardRejected(id, err) {
    const g = findGroup(id);
    const server = await remote.getGroup(session.token, g.token);
    const latest = findGroup(id);
    if (!latest) return;
    if (!server) {
      // The group vanished from the account: re-create it from this copy.
      putGroup(Object.assign({}, latest, { token: null, owned: false, version: 0, syncedRev: -1 }));
      return;
    }
    ops.set(id, []);
    putGroup(Object.assign(fromServer(latest, server), { rev: latest.rev, syncedRev: latest.rev }));
    if (id === state.id) render();
    const reason = /members_unique_name/.test(err.message) ? 'that name is already in the group' : 'it clashed with a newer edit';
    toast(`Couldn't save your last change (${reason}). Showing the latest version.`);
  }

  /** Fetch the latest server copy and replay our unsaved changes on top of it. */
  async function rebase(id) {
    const g = findGroup(id);
    const server = await remote.getGroup(session.token, g.token);
    const latest = findGroup(id);
    if (!server || !latest) return;
    let next = fromServer(latest, server);
    const kept = [];
    let dropped = 0;
    for (const op of pendingOps(id)) {
      try {
        const trial = JSON.parse(JSON.stringify(next));
        op.mutate(trial);
        calculateBalances(trial);
        next = trial;
        kept.push(op);
      } catch (_) {
        dropped++;
      }
    }
    const lostOffline = latest.rev !== latest.syncedRev && pendingOps(id).length === 0;
    ops.set(id, kept);
    next.rev = latest.rev;
    next.syncedRev = kept.length ? latest.rev - 1 : latest.rev;
    putGroup(next);
    if (id === state.id) render();
    if (dropped || lostOffline) {
      toast('This group was also changed on another device — some of your edits could not be applied');
    }
  }

  /** Refresh a group from the server if it changed elsewhere (skipped while we have unsaved edits). */
  async function pull(id) {
    if (!canSync()) return;
    const g = findGroup(id);
    if (!g || !g.token || !g.owned || inflight.has(id)) return;
    if (g.rev !== g.syncedRev && !g.loading) return; // our own unsaved edits win until they're pushed
    let server;
    try {
      server = await remote.getGroup(session.token, g.token);
      offline = false;
    } catch (err) {
      if (err.signedOut) return handleSignedOut();
      offline = true;
      renderSyncStatus();
      return;
    }
    const latest = findGroup(id);
    if (!latest || inflight.has(id)) return;
    if (!server) {
      // Deleted on another device (or not this account's).
      if (latest.rev === latest.syncedRev) removeGroupLocally(id);
      return;
    }
    if (latest.rev !== latest.syncedRev) {
      if (latest.loading) { await rebase(id); sync(id); } // edits made while it was loading
      return;
    }
    if (server.version === latest.version && !latest.loading) return renderSyncStatus();
    putGroup(fromServer(latest, server));
    if (id === state.id) render();
    else if (groupsDialog.open) renderGroupList();
  }

  /** Bring this device's list in line with the account: add new groups, drop deleted ones, pull changes. */
  async function refreshGroupList() {
    if (!canSync()) return;
    let list;
    try {
      list = await remote.listGroups(session.token);
      offline = false;
    } catch (err) {
      if (err.signedOut) return handleSignedOut();
      offline = true;
      return renderSyncStatus();
    }
    if (!canSync()) return;
    const byToken = new Map(list.map((item) => [item.token, item]));
    const deleting = new Set([...pendingDeletes.values()].map((p) => p.token)); // still on the server until Undo expires
    let changed = false;
    for (const item of list) {
      if (!deleting.has(item.token) && !store.groups.some((g) => g.token === item.token)) {
        store.groups.push(Object.assign(newGroup(item.name), { token: item.token, owned: true, version: -1, loading: true }));
        changed = true;
      }
    }
    for (const g of store.groups.slice()) {
      const gone = g.owned && g.token && !byToken.has(g.token);
      if (gone && g.rev === g.syncedRev && !inflight.has(g.id) && !pendingDeletes.has(g.id)) {
        removeGroupLocally(g.id);
        changed = true;
      }
    }
    // An untouched starter group is just clutter once the account's own groups arrive.
    if (store.groups.length > 1) {
      const clutter = store.groups.filter((g) => !g.token && g.rev === 0 && !hasContent(g));
      if (clutter.length && clutter.length < store.groups.length) {
        store.groups = store.groups.filter((g) => !clutter.includes(g));
        if (!store.groups.includes(state)) state = store.groups[0];
        store.activeGroupId = state.id;
        changed = true;
      }
    }
    if (changed) {
      save();
      render();
      updateHash();
      if (groupsDialog.open) renderGroupList();
    }
    for (const g of store.groups) {
      const item = g.token && byToken.get(g.token);
      if (item && (g.loading || item.version !== g.version)) pull(g.id);
    }
  }

  function removeGroupLocally(id) {
    const index = store.groups.findIndex((g) => g.id === id);
    if (index < 0) return;
    store.groups.splice(index, 1);
    ops.delete(id);
    if (!store.groups.length) store.groups.push(newGroup('My group'));
    if (state.id === id) switchGroup(store.groups[Math.min(index, store.groups.length - 1)].id);
    else { save(); render(); }
  }

  const tokenFromHash = () => {
    const m = /[#&]g=([0-9a-f-]{36})\b/i.exec(location.hash);
    return m ? m[1].toLowerCase() : null;
  };

  /** Keep #g=<token> in the address bar for the open group, so a refresh or bookmark returns to it. */
  function updateHash() {
    if (!remote) return;
    const token = canSync() && state.owned ? state.token : null;
    const want = token ? `#g=${token}` : '';
    if (location.hash !== want) history.replaceState(null, '', token ? want : location.pathname + location.search);
  }

  /** Open the group in the URL (#g=<token>). Groups are private: it must be (or become) this account's. */
  async function openFromLink() {
    const token = tokenFromHash();
    if (!remote || !token) return;
    const existing = store.groups.find((x) => x.token === token);
    if (existing) {
      if (existing.id !== state.id) switchGroup(existing.id);
      return;
    }
    if (!session) {
      toast('Sign in to open this group');
      openAuth('signin');
      return;
    }
    let mine = false;
    try {
      mine = await remote.claimGroup(session.token, token); // true for our own, or an unowned older group
    } catch (err) {
      if (err.signedOut) return handleSignedOut();
      return toast('Could not open that group — check your connection');
    }
    if (!mine) {
      toast('That group belongs to another account');
      updateHash();
      return;
    }
    const g = Object.assign(newGroup('Loading group…'), { token, owned: true, version: -1, loading: true });
    store.groups.push(g);
    switchGroup(g.id);
  }

  function renderSyncStatus() {
    const pill = $('#sync-status');
    pill.hidden = !remote;
    if (!remote) return;
    let cls = 'synced';
    let text = 'Synced to your account';
    if (!session) [cls, text] = ['local', 'Only on this device'];
    else if (state.loading) [cls, text] = ['saving', 'Loading…'];
    else if (inflight.has(state.id)) [cls, text] = ['saving', 'Saving…'];
    else if (offline && needsSync(state)) [cls, text] = ['offline', 'Offline — will retry'];
    else if (!state.token) [cls, text] = ['local', 'Saves once you add someone'];
    else if (state.rev !== state.syncedRev) [cls, text] = ['saving', 'Waiting to save'];
    pill.className = `sync-pill ${cls}`;
    pill.textContent = text;
  }

  function uid(prefix) {
    const rand = window.crypto && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
    return `${prefix}_${Date.now().toString(36)}${rand}`;
  }

  // ---------- helpers ----------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const member = (id) => state.members.find((m) => m.id === id);
  const nameOf = (id) => (member(id) ? member(id).name : 'Unknown');

  const AVATAR_TONES = [
    ['#EA580C', '#FFFFFF'],
    ['#FFEDD5', '#9A3412'],
    ['#3B302A', '#FFEDD5'],
    ['#FB923C', '#FFFFFF'],
    ['#FED7AA', '#7C2D12'],
    ['#C2410C', '#FFF7ED'],
  ];
  /** A member's avatar: their photo, their emoji, or coloured initials. */
  function avatarFor(m, index, small) {
    const size = small ? ' avatar-sm' : '';
    const value = m && m.avatar;
    const kind = UI.avatarKind(value);
    if (kind === 'photo') return `<span class="avatar photo${size}"><img src="${value}" alt=""></span>`; // validated data: URL
    if (kind === 'emoji') return `<span class="avatar emoji${size}">${esc(value)}</span>`;
    const [bg, fg] = AVATAR_TONES[Math.max(0, index) % AVATAR_TONES.length];
    const initials = (m ? m.name : '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    return `<span class="avatar${size}" style="background:${bg};color:${fg}">${esc(initials)}</span>`;
  }

  function avatar(id, small) {
    const i = state.members.findIndex((m) => m.id === id);
    return avatarFor(state.members[i], i, small);
  }

  // ---------- motion helpers ----------

  const counts = new Map(); // what each animated number showed last, so changes count from there
  function countUp(el, key, value, format) {
    const from = counts.has(key) ? counts.get(key) : 0;
    counts.set(key, value);
    UI.countTo(el, from, value, format || formatPaise);
  }

  const barWidths = new Map(); // key → { w, cls } of each balance bar last frame
  let celebrateNext = false; // set by commit(): only the user's own change can trigger the celebration
  let quietCommit = false; // set before an Undo, which shouldn't celebrate again
  const settledBefore = new Map(); // groupId → was everyone square at the last render

  const money = (p, opts) => `<span class="num">${formatPaise(p, opts)}</span>`;
  const humanError = (err) => {
    const msg = err instanceof ValidationError ? err.message : 'Something went wrong';
    return msg.charAt(0).toUpperCase() + msg.slice(1) + '.';
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function toast(message, action) {
    const el = document.createElement('div');
    el.className = 'toast' + (action ? '' : ' plain');
    el.innerHTML = `<span>${esc(message)}</span>`;
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      btn.onclick = () => { action.run(); el.remove(); };
      el.appendChild(btn);
    }
    // Modal dialogs sit in the top layer, so show the toast inside the open one.
    const host = $('#toasts');
    const openDialog = document.querySelector('dialog[open]');
    (openDialog || document.body).appendChild(host);
    host.replaceChildren(el);
    setTimeout(() => el.remove(), action ? 6000 : 3200);
  }

  // ---------- rendering ----------

  function render() {
    const { balances, debts } = calculateBalances(state);
    const transfers = suggestSettlements(balances);
    renderHero(balances, transfers);
    renderBalances(balances);
    renderTransfers(transfers);
    renderDebts(debts);
    renderMembers();
    renderActivity();
    renderGroupButton();
    renderSyncStatus();
    renderSpending();
    renderPeopleSpend();
    $('#btn-add').disabled = state.members.length === 0;
    $('#btn-pay').disabled = state.members.length < 2;

    // Celebrate when the user's own change squares everyone up.
    const settledNow = state.expenses.length > 0 && transfers.length === 0;
    if (celebrateNext && settledBefore.get(state.id) === false && settledNow) celebrate();
    settledBefore.set(state.id, settledNow);
    celebrateNext = false;
  }

  function celebrate() {
    UI.confetti();
    const card = $('#transfers .settled');
    if (card) card.classList.add('pop');
    // after the action's own toast ("Parthiv paid Akhil …"), so this one stays on screen
    setTimeout(() => toast('Everyone’s square! 🎉 No payments left in this group'), 0);
  }

  function renderHero(balances, transfers) {
    const input = $('#group-name');
    if (document.activeElement !== input) input.value = state.groupName;
    const n = store.groups.length;
    $('#hero-eyebrow').textContent = n > 1 ? `Group ${store.groups.indexOf(state) + 1} of ${n}` : 'Group';
    const spent = state.expenses.reduce((a, e) => a + e.amount, 0);
    const outstanding = Object.values(balances).reduce((a, v) => a + (v > 0 ? v : 0), 0);
    $('#hero-sub').textContent = state.members.length
      ? `${plural(state.members.length, 'member')} · ${plural(state.expenses.length, 'expense')} · ${plural(state.settlements.length, 'payment')}`
      : 'Add the people you are splitting with to get started.';
    $('#stats').innerHTML = `
      <div class="stat"><dt>Total spent</dt><dd data-count="spent"></dd></div>
      <div class="stat"><dt>Outstanding</dt><dd data-count="owed"></dd></div>
      <div class="stat"><dt>To settle</dt><dd data-count="settle"></dd></div>`;
    countUp($('#stats [data-count=spent]'), `spent:${state.id}`, spent);
    countUp($('#stats [data-count=owed]'), `owed:${state.id}`, outstanding);
    countUp($('#stats [data-count=settle]'), `settle:${state.id}`, transfers.length, (n) => plural(n, 'payment'));
  }

  function renderBalances(balances) {
    const list = $('#balances');
    if (!state.members.length) {
      list.innerHTML = `<li class="empty" style="display:block"><strong>No one here yet</strong>Add members, or load a demo trip to explore.
        <br><button class="btn btn-primary btn-sm" type="button" data-demo>Load demo trip</button></li>`;
      return;
    }
    const max = Math.max(1, ...Object.values(balances).map(Math.abs));
    const paid = {};
    for (const e of state.expenses) paid[e.paidBy] = (paid[e.paidBy] || 0) + e.amount;

    list.innerHTML = state.members
      .slice()
      .sort((a, b) => balances[b.id] - balances[a.id])
      .map((m) => {
        const v = balances[m.id];
        const cls = v > 0 ? 'get' : v < 0 ? 'owe' : 'zero';
        const label = v > 0 ? 'gets back' : v < 0 ? 'owes' : 'settled up';
        const width = (Math.abs(v) / max) * 50;
        const prev = barWidths.get(`${state.id}:${m.id}`);
        const from = prev && prev.cls === cls ? prev.w : 0; // bars grow from where they were
        barWidths.set(`${state.id}:${m.id}`, { w: width, cls });
        return `<li>
          ${avatar(m.id)}
          <div class="who"><strong>${esc(m.name)}</strong><small>Paid ${formatPaise(paid[m.id] || 0)}</small></div>
          <div class="bar" role="img" aria-label="${esc(m.name)} ${label} ${formatPaise(Math.abs(v))}">${v ? `<i class="${cls}" data-w="${width}" style="width:${from}%"></i>` : ''}</div>
          <div class="amt ${cls}"><small>${label}</small><span data-bal="${esc(m.id)}"></span></div>
        </li>`;
      })
      .join('');
    for (const m of state.members) {
      const v = Math.abs(balances[m.id]);
      countUp(list.querySelector(`[data-bal="${CSS.escape(m.id)}"]`), `bal:${state.id}:${m.id}`, v, (p) => (p ? formatPaise(p) : '—'));
    }
    const grow = () => list.querySelectorAll('.bar i[data-w]').forEach((bar) => { bar.style.width = `${bar.dataset.w}%`; });
    if (document.hidden) grow(); // no animation frames in hidden tabs
    else requestAnimationFrame(grow);
  }

  function renderTransfers(transfers) {
    const list = $('#transfers');
    if (!state.members.length) {
      list.innerHTML = '';
      return;
    }
    if (!transfers.length) {
      list.innerHTML = `<li class="settled" style="background:var(--orange-50)">
        <span class="check"><svg viewBox="0 0 20 20"><path d="m5 10 3.5 3.5L15 7"/></svg></span>
        <span><strong style="color:var(--ink)">Everyone's square.</strong> ${state.expenses.length ? 'No payments needed.' : 'Add an expense to see who owes whom.'}</span>
      </li>`;
      return;
    }
    list.innerHTML = transfers
      .map((t, i) => `<li>
        <div class="route">
          ${avatar(t.from, true)}
          <svg class="route-arrow" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12m-4-4 4 4-4 4"/></svg>
          ${avatar(t.to, true)}
          <div class="names"><b>${esc(nameOf(t.from))}</b> <span>pays</span> <b>${esc(nameOf(t.to))}</b></div>
        </div>
        <span class="transfer-amt">${formatPaise(t.amount)}</span>
        <button class="btn btn-soft btn-sm" type="button" data-settle="${i}">Record</button>
      </li>`)
      .join('');
    list.querySelectorAll('[data-settle]').forEach((btn) => {
      btn.onclick = () => openPayment(transfers[Number(btn.dataset.settle)]);
    });
  }

  function renderDebts(debts) {
    const list = $('#debts');
    list.innerHTML = debts.length
      ? debts
          .map((d) => `<li><span><b>${esc(nameOf(d.from))}</b> owes <b>${esc(nameOf(d.to))}</b></span><span class="amt">${formatPaise(d.amount)}</span></li>`)
          .join('')
      : `<li><span>No outstanding debts between any pair.</span></li>`;
  }

  function isReferenced(id) {
    return (
      state.expenses.some((e) => e.paidBy === id || e.splits.some((s) => s.memberId === id)) ||
      state.settlements.some((s) => s.from === id || s.to === id)
    );
  }

  function renderMembers() {
    $('#members-sub').textContent = state.members.length
      ? `${plural(state.members.length, 'person')} in this group`.replace('persons', 'people')
      : 'Who are you splitting with?';
    const list = $('#members');
    list.innerHTML = state.members
      .map((m) => `<li data-row="m:${esc(m.id)}">
        <button class="member-pick" type="button" data-person="${esc(m.id)}" aria-label="Edit ${esc(m.name)} (name, emoji or photo)">
          ${avatar(m.id, true)}<span>${esc(m.name)}</span></button>
        <button class="icon-btn" type="button" data-remove="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">
          <svg viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"/></svg></button></li>`)
      .join('');
    markNewRows(list, 'members');
  }

  // Rows that weren't on screen last time slide in (not on first paint or when switching groups).
  const seenRows = new Map(); // `${groupId}:${listName}` → Set of row keys
  function markNewRows(list, name) {
    const key = `${state.id}:${name}`;
    const before = seenRows.get(key);
    const now = new Set();
    list.querySelectorAll('[data-row]').forEach((li) => {
      now.add(li.dataset.row);
      if (before && !before.has(li.dataset.row)) li.classList.add('enter');
    });
    seenRows.set(key, now);
  }

  const catColor = (name) => window.SplitCharts.cssColor(categoryColor(name));

  const categoryColor = (name) => Cat.presetColor(name) || Cat.CUSTOM_COLOR;

  function describeSplit(e) {
    const n = e.splits.filter((s) => s.amount > 0).length;
    const mode = e.splitMode === 'exact' ? 'exact amounts' : e.splitMode === 'percent' ? 'by percentage' : 'equally';
    const cat = Cat.categoryOf(e);
    return `${UI.categoryIcon(Cat.isPreset(cat) ? cat : 'custom', catColor(cat))}${esc(cat)} · ${esc(nameOf(e.paidBy))} paid · split ${mode} · ${plural(n, 'person').replace('persons', 'people')}`;
  }

  // ---------- spending chart ----------

  let chartWidth = 0;
  let spendMonth = null; // a month key ('2026-09') when showing that month day by day
  let lastSpendSig = '';
  let lastDonutSig = '';

  function renderSpending() {
    const scope = (document.querySelector('input[name=spend-scope]:checked') || {}).value || 'group';
    const expenses = scope === 'all' ? store.groups.flatMap((g) => g.expenses) : state.expenses;
    const monthly = Cat.monthlySpend(expenses);
    if (spendMonth && !monthly.months.some((m) => m.key === spendMonth && m.total > 0)) spendMonth = null;
    const summary = spendMonth ? Cat.dailySpend(expenses, spendMonth) : monthly;
    const who = scope === 'all' ? (store.groups.length > 1 ? `All ${store.groups.length} groups` : 'All groups') : 'This group';
    const n = summary.months.length;
    if (spendMonth) {
      $('#spend-sub').textContent = `${who} · ${Cat.monthLabel(spendMonth)} by day · ${formatPaise(summary.total)}`;
    } else {
      $('#spend-sub').textContent = n
        ? `${who} · ${summary.months[0].label}${n > 1 ? ` – ${summary.months[n - 1].label}` : ''} · ${formatPaise(summary.total)} · tap a month to see its days`
        : 'Monthly, by category';
    }
    $('#spend-back').hidden = !spendMonth;
    const box = $('#spend-chart');
    chartWidth = box.clientWidth;
    // Grow in only when the numbers change (not on every redraw or resize).
    const sig = JSON.stringify([state.id, scope, spendMonth, summary.months.map((m) => [m.key, m.total])]);
    const animate = sig !== lastSpendSig;
    lastSpendSig = sig;
    window.SplitCharts.renderSpending(box, summary, {
      animate,
      formatMoney: (p) => formatPaise(p),
      bucketName: spendMonth ? 'Day' : 'Month',
      onSelect: spendMonth ? null : (month) => { spendMonth = month.key; renderSpending(); },
    });
  }

  $('#spend-back').addEventListener('click', () => { spendMonth = null; renderSpending(); });

  // ---------- who spent what (donut) ----------

  function renderPeopleSpend() {
    const mode = (document.querySelector('input[name=people-mode]:checked') || {}).value || 'paid';
    const data = Cat.spendByPerson(state, mode);
    $('#people-spend-sub').textContent = mode === 'share'
      ? 'Each person’s portion of the expenses'
      : 'Out of their own pocket (payments between you are not counted)';
    const sig = JSON.stringify([state.id, mode, data.items.map((it) => [it.id, it.total])]);
    const animate = sig !== lastDonutSig;
    lastDonutSig = sig;
    window.SplitCharts.renderDonut($('#people-chart'), data, {
      animate,
      formatMoney: (p) => formatPaise(p),
      title: mode === 'share' ? 'Share of expenses' : 'Paid out of pocket',
      centerLabel: mode === 'share' ? 'shared' : 'paid',
      emptyTitle: state.members.length ? 'No expenses yet' : 'No one here yet',
      emptyText: 'Add an expense to see how much each person spent.',
    });
  }

  document.querySelectorAll('input[name=people-mode]').forEach((r) => r.addEventListener('change', renderPeopleSpend));
  document.querySelectorAll('input[name=spend-scope]').forEach((r) => r.addEventListener('change', renderSpending));
  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (Math.abs($('#spend-chart').clientWidth - chartWidth) > 8) renderSpending(); }).observe($('#spend-chart'));
  }

  // ---------- PDF statement ----------

  let exporting = false;

  /** Download a group's statement as a PDF (from the hero button or the Groups list). */
  async function exportStatement(group) {
    if (exporting) return;
    if (!group || group.loading) return toast('That group is still loading — try again in a moment');
    if (!group.members.length) return toast(`Add people and expenses to ${group.groupName} first`);
    exporting = true;
    toast('Preparing your statement…');
    try {
      const name = await window.SplitStatement.download(group, {
        calculateBalances, suggestSettlements, formatPaise,
        categoryOf: Cat.categoryOf, monthlySpend: Cat.monthlySpend,
      });
      toast(`Downloaded ${name}`);
    } catch (err) {
      console.error(err);
      toast(err && /PDF library/.test(err.message) ? err.message : 'Could not create the PDF');
    } finally {
      exporting = false;
    }
  }

  $('#btn-export').addEventListener('click', () => exportStatement(state));

  function dateBadge(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return `<span class="act-date">${d.toLocaleDateString('en-IN', { month: 'short' })}<b>${d.getDate()}</b></span>`;
  }

  function renderActivity() {
    const items = [
      ...state.expenses.map((e) => ({ kind: 'expense', at: e.createdAt, item: e })),
      ...state.settlements.map((s) => ({ kind: 'payment', at: s.createdAt, item: s })),
    ].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));

    const list = $('#activity');
    if (!items.length) {
      list.innerHTML = `<li class="empty" style="display:block"><strong>Nothing yet</strong>Expenses and payments will show up here.</li>`;
      seenRows.set(`${state.id}:activity`, new Set()); // so the first real item slides in
      return;
    }
    list.innerHTML = items
      .map(({ kind, item }) => {
        if (kind === 'expense') {
          return `<li data-row="e:${esc(item.id)}">
            <span class="act-icon">${dateBadge(item.createdAt)}</span>
            <div class="act-main"><strong>${esc(item.description || 'Expense')}</strong><small>${describeSplit(item)}</small></div>
            <div class="act-side">
              <span class="act-amt">${formatPaise(item.amount)}</span>
              <span class="act-tools">
                <button class="icon-btn" type="button" data-edit="${esc(item.id)}" aria-label="Edit ${esc(item.description)}">
                  <svg viewBox="0 0 20 20"><path d="M12.5 4.5l3 3L7 16H4v-3z"/></svg></button>
                <button class="icon-btn" type="button" data-del-expense="${esc(item.id)}" aria-label="Delete ${esc(item.description)}">
                  <svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2m-6 0 .7 10h6.6L14 6"/></svg></button>
              </span>
            </div></li>`;
        }
        return `<li data-row="s:${esc(item.id)}">
          <span class="act-icon pay"><svg viewBox="0 0 20 20"><path d="M4 10h12m-4-4 4 4-4 4"/></svg></span>
          <div class="act-main"><strong>${esc(nameOf(item.from))} paid ${esc(nameOf(item.to))}</strong>
            <small>Payment${item.note ? ' · ' + esc(item.note) : ''}</small></div>
          <div class="act-side">
            <span class="act-amt">${formatPaise(item.amount)}</span>
            <span class="act-tools">
              <button class="icon-btn" type="button" data-del-payment="${esc(item.id)}" aria-label="Delete payment">
                <svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2m-6 0 .7 10h6.6L14 6"/></svg></button>
            </span>
          </div></li>`;
      })
      .join('');
    markNewRows(list, 'activity');
  }

  // ---------- members & group ----------

  $('#add-member').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('#member-name');
    const name = input.value.trim().replace(/\s+/g, ' ');
    if (!name) return;
    if (state.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      toast(`${name} is already in the group`);
      return;
    }
    commit((s) => s.members.push({ id: uid('m'), name }));
    input.value = '';
    input.focus();
  });

  $('#members').addEventListener('click', async (ev) => {
    const person = ev.target.closest('[data-person]');
    if (person) return openPerson(person.dataset.person);
    const btn = ev.target.closest('[data-remove]');
    if (!btn) return;
    const id = btn.dataset.remove;
    if (isReferenced(id)) {
      toast(`${nameOf(id)} is part of existing transactions — remove those first`);
      return;
    }
    const row = btn.closest('li');
    if (row.classList.contains('leaving')) return;
    await UI.animateOut(row);
    commit((s) => { s.members = s.members.filter((m) => m.id !== id); });
  });

  $('#group-name').addEventListener('change', (ev) => {
    const name = ev.target.value.trim() || 'Untitled group';
    commit((s) => { s.groupName = name; });
  });
  $('#group-name').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.target.blur(); });

  // ---------- activity actions (edit / delete with undo) ----------

  $('#activity').addEventListener('click', (ev) => {
    const edit = ev.target.closest('[data-edit]');
    const delE = ev.target.closest('[data-del-expense]');
    const delP = ev.target.closest('[data-del-payment]');
    if (edit) openExpense(state.expenses.find((e) => e.id === edit.dataset.edit));
    if (delE) removeWithUndo('expenses', delE.dataset.delExpense, 'Expense deleted');
    if (delP) removeWithUndo('settlements', delP.dataset.delPayment, 'Payment deleted');
  });

  async function removeWithUndo(collection, id, message) {
    const row = $('#activity').querySelector(`[data-row="${collection === 'expenses' ? 'e' : 's'}:${CSS.escape(id)}"]`);
    if (row && row.classList.contains('leaving')) return;
    const groupId = state.id;
    await UI.animateOut(row); // the row folds away, then the change is made
    if (state.id !== groupId) return;
    const index = state[collection].findIndex((x) => x.id === id);
    if (index < 0) return;
    const removed = state[collection][index];
    commit((s) => { s[collection].splice(index, 1); });
    toast(message, {
      label: 'Undo',
      run: () => {
        try {
          quietCommit = true;
          commit((s) => { s[collection].splice(Math.min(index, s[collection].length), 0, removed); }, groupId);
        } catch (err) {
          toast(humanError(err));
        }
      },
    });
  }

  // ---------- expense dialog ----------

  const exDialog = $('#expense-dialog');
  const exForm = $('#expense-form');
  let editingId = null;
  let draft = null; // { mode, included: Set, exact: {id: text}, percent: {id: text} }

  function openExpense(existing) {
    if (!state.members.length) return;
    editingId = existing ? existing.id : null;
    $('#expense-title').textContent = existing ? 'Edit expense' : 'Add expense';
    $('#ex-save').textContent = existing ? 'Save changes' : 'Save expense';
    $('#ex-error').textContent = '';

    $('#ex-payer').innerHTML = state.members.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    $('#ex-amount').value = existing ? (existing.amount / 100).toFixed(2) : '';
    $('#ex-desc').value = existing ? existing.description : '';
    $('#ex-payer').value = existing ? existing.paidBy : state.members[0].id;
    const when = existing && !isNaN(new Date(existing.createdAt)) ? new Date(existing.createdAt) : new Date();
    $('#ex-date').value = localDay(when);
    $('#ex-date').max = localDay(new Date());

    const ids = state.members.map((m) => m.id);
    draft = { mode: 'equal', included: new Set(ids), exact: {}, percent: {} };
    if (existing) {
      draft.mode = existing.splitMode || 'exact';
      const input = existing.splitInput || {};
      if (draft.mode === 'equal') draft.included = new Set(existing.splits.map((s) => s.memberId));
      if (draft.mode === 'percent') draft.percent = Object.assign({}, input.percent);
      if (draft.mode === 'exact') {
        for (const s of existing.splits) if (s.amount) draft.exact[s.memberId] = (s.amount / 100).toFixed(2);
      }
    }
    exForm.querySelector(`input[name=mode][value=${draft.mode}]`).checked = true;
    const cat = existing ? Cat.categoryOf(existing) : 'Other';
    category = { value: cat, custom: !Cat.isPreset(cat), touched: !!(existing && existing.category) };
    $('#ex-cat-custom').value = category.custom ? cat : '';
    renderCategoryChips();
    renderSplitRows();
    exDialog.showModal();
    setTimeout(() => $('#ex-amount').focus(), 30);
  }

  const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  /** The picked day as an ISO timestamp. Keeps the original time of day when the day is unchanged. */
  function expenseDate(previousIso) {
    const day = $('#ex-date').value;
    const prev = previousIso ? new Date(previousIso) : null;
    if (prev && !isNaN(prev) && localDay(prev) === day) return previousIso;
    const [y, m, d] = day.split('-').map(Number);
    const now = new Date();
    const at = localDay(now) === day ? now : new Date(y, m - 1, d, 12, 0, 0); // past days: midday
    return at.toISOString();
  }

  // Category: a preset chip, or "Custom…" with a free-text name. Until the user picks one,
  // it follows a guess from the description.
  let category = { value: 'Other', custom: false, touched: false };

  function renderCategoryChips() {
    const chips = Cat.PRESETS.map((p) => {
      const on = !category.custom && category.value === p.name;
      return `<button type="button" class="cat-chip" role="radio" aria-checked="${on}" data-cat="${esc(p.name)}">
        ${UI.categoryIcon(p.name, catColor(p.name))}${esc(p.name)}</button>`;
    });
    chips.push(`<button type="button" class="cat-chip" role="radio" aria-checked="${category.custom}" data-cat-custom>
      ${UI.categoryIcon('custom', window.SplitCharts.cssColor(Cat.CUSTOM_COLOR))}Custom…</button>`);
    $('#ex-cats').innerHTML = chips.join('');
    $('#ex-cat-custom').hidden = !category.custom;
    const customs = Cat.customCategories(store.groups.flatMap((g) => g.expenses));
    $('#custom-cats').innerHTML = customs.map((c) => `<option value="${esc(c)}"></option>`).join('');
  }

  $('#ex-cats').addEventListener('click', (ev) => {
    const preset = ev.target.closest('[data-cat]');
    const custom = ev.target.closest('[data-cat-custom]');
    if (preset) category = { value: preset.dataset.cat, custom: false, touched: true };
    else if (custom) category = { value: $('#ex-cat-custom').value.trim(), custom: true, touched: true };
    else return;
    renderCategoryChips();
    if (custom) $('#ex-cat-custom').focus();
  });

  /** Build the explicit paise splits from the current draft. Throws ValidationError. */
  function buildSplits(amount) {
    const ids = state.members.map((m) => m.id);
    if (draft.mode === 'equal') {
      return splitEqually(amount, ids.filter((id) => draft.included.has(id)));
    }
    if (draft.mode === 'exact') {
      const entries = [];
      for (const id of ids) {
        const text = (draft.exact[id] || '').trim();
        if (!text) continue;
        const p = parseRupees(text);
        if (p === null) throw new ValidationError(`${nameOf(id)}'s share is not a valid amount`);
        if (p > 0) entries.push({ memberId: id, amount: p });
      }
      return splitExact(amount, entries);
    }
    const entries = [];
    for (const id of ids) {
      const text = (draft.percent[id] || '').trim();
      if (!text) continue;
      if (!/^\d+(\.\d{0,2})?$/.test(text)) throw new ValidationError(`${nameOf(id)}'s percentage is not valid`);
      const percent = Number(text);
      if (percent > 0) entries.push({ memberId: id, percent });
    }
    return splitByPercentage(amount, entries);
  }

  function currentAmount() {
    return parseRupees($('#ex-amount').value);
  }

  function renderSplitRows() {
    const amount = currentAmount();
    let preview = {};
    try {
      if (amount) for (const s of buildSplits(amount)) preview[s.memberId] = s.amount;
    } catch (_) { preview = null; }

    const rows = state.members.map((m) => {
      const id = esc(m.id);
      if (draft.mode === 'equal') {
        const on = draft.included.has(m.id);
        const share = on && preview && amount ? formatPaise(preview[m.id] || 0) : on ? '—' : 'Not included';
        return `<li class="${on ? 'on' : 'off'}">
          <label class="toggle"><input type="checkbox" data-include="${id}" ${on ? 'checked' : ''} aria-label="Include ${esc(m.name)}">${avatar(m.id)}</label>
          <span class="name">${esc(m.name)}</span>
          <span class="share">${share}</span></li>`;
      }
      if (draft.mode === 'exact') {
        const val = draft.exact[m.id] || '';
        return `<li class="${val ? 'on' : ''}">${avatar(m.id)}
          <span class="name">${esc(m.name)}</span>
          <span class="unit-input"><i>₹</i><input inputmode="decimal" placeholder="0.00" data-exact="${id}" value="${esc(val)}" aria-label="${esc(m.name)}'s share in rupees"></span></li>`;
      }
      const val = draft.percent[m.id] || '';
      const sub = preview && amount && preview[m.id] ? `<small>${formatPaise(preview[m.id])}</small>` : '';
      return `<li class="${val ? 'on' : ''}">${avatar(m.id)}
        <span class="name">${esc(m.name)}${sub}</span>
        <span class="unit-input pct"><input inputmode="decimal" placeholder="0" data-percent="${id}" value="${esc(val)}" aria-label="${esc(m.name)}'s percentage"><i>%</i></span></li>`;
    });
    $('#split-rows').innerHTML = rows.join('');
    renderMeter();
  }

  function renderMeter() {
    const amount = currentAmount() || 0;
    const meter = $('#split-meter');
    if (draft.mode === 'equal') {
      const n = draft.included.size;
      meter.innerHTML = n
        ? `<span>Split between <b>${plural(n, 'person').replace('persons', 'people')}</b></span>${
            amount && amount % n ? `<span>${amount % n} paise go to the first ${amount % n === 1 ? 'person' : amount % n + ' people'}</span>` : ''}`
        : `<span>Pick at least one person</span>`;
      return;
    }
    let assigned = 0;
    let target = draft.mode === 'exact' ? amount : 10000;
    for (const m of state.members) {
      const text = ((draft.mode === 'exact' ? draft.exact : draft.percent)[m.id] || '').trim();
      if (!text) continue;
      const v = draft.mode === 'exact' ? parseRupees(text) : Math.round(Number(text) * 100);
      if (Number.isFinite(v) && v !== null) assigned += v;
    }
    const fmt = draft.mode === 'exact' ? formatPaise : (bp) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;
    const pct = target ? Math.min(100, (assigned / target) * 100) : 0;
    const left = target - assigned;
    const status = !target
      ? 'Enter the amount first'
      : left === 0
        ? `<span class="ok">All assigned ✓</span>`
        : left > 0
          ? `<b>${fmt(left)}</b> left`
          : `<b>${fmt(-left)}</b> over`;
    meter.innerHTML = `<span><b>${fmt(assigned)}</b> of ${fmt(target)}</span>
      <span class="track"><i class="${left < 0 ? 'over' : ''}" style="width:${pct}%"></i></span><span>${status}</span>`;
  }

  exForm.addEventListener('change', (ev) => {
    if (ev.target.name === 'mode') {
      draft.mode = ev.target.value;
      renderSplitRows();
    } else if (ev.target.dataset.include) {
      const id = ev.target.dataset.include;
      if (ev.target.checked) draft.included.add(id);
      else draft.included.delete(id);
      renderSplitRows();
    }
  });

  exForm.addEventListener('input', (ev) => {
    const t = ev.target;
    $('#ex-error').textContent = '';
    if (t.id === 'ex-desc' && !category.touched) {
      const guess = Cat.guessCategory(t.value);
      if (guess !== category.value || category.custom) {
        category = { value: guess, custom: false, touched: false };
        renderCategoryChips();
      }
    } else if (t.id === 'ex-cat-custom') {
      category.value = t.value.trim();
    } else if (t.id === 'ex-amount') {
      updatePreviewOnly();
    } else if (t.dataset.exact) {
      draft.exact[t.dataset.exact] = t.value;
      t.closest('li').classList.toggle('on', !!t.value.trim());
      renderMeter();
    } else if (t.dataset.percent) {
      draft.percent[t.dataset.percent] = t.value;
      t.closest('li').classList.toggle('on', !!t.value.trim());
      updatePreviewOnly();
    }
  });

  /** Refresh computed shares without replacing inputs (keeps cursor position). */
  function updatePreviewOnly() {
    if (draft.mode === 'exact') return renderMeter();
    const amount = currentAmount();
    let preview = null;
    try { if (amount) preview = Object.fromEntries(buildSplits(amount).map((s) => [s.memberId, s.amount])); } catch (_) {}
    $('#split-rows').querySelectorAll('li').forEach((li, i) => {
      const m = state.members[i];
      if (draft.mode === 'equal') {
        const on = draft.included.has(m.id);
        li.querySelector('.share').textContent = on && preview ? formatPaise(preview[m.id] || 0) : on ? '—' : 'Not included';
      } else {
        const name = li.querySelector('.name');
        const sub = name.querySelector('small');
        const text = preview && preview[m.id] ? formatPaise(preview[m.id]) : '';
        if (text && !sub) name.insertAdjacentHTML('beforeend', `<small>${text}</small>`);
        else if (sub) text ? (sub.textContent = text) : sub.remove();
      }
    });
    renderMeter();
  }

  exForm.addEventListener('submit', (ev) => {
    if (ev.submitter && ev.submitter.value === 'cancel') return;
    ev.preventDefault();
    const err = $('#ex-error');
    const amount = currentAmount();
    if (amount === null) {
      err.textContent = 'Enter an amount like 450 or 450.50.';
      $('#ex-amount').focus();
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test($('#ex-date').value)) {
      err.textContent = 'Pick the date of the expense.';
      $('#ex-date').focus();
      return;
    }
    const chosen = category.custom ? Cat.normalizeCategory($('#ex-cat-custom').value) : category.value;
    if (!chosen) {
      err.textContent = 'Type a name for your category, or pick one of the list.';
      $('#ex-cat-custom').focus();
      return;
    }
    try {
      const splits = buildSplits(amount);
      const record = {
        id: editingId || uid('e'),
        description: $('#ex-desc').value.trim() || 'Expense',
        category: chosen,
        paidBy: $('#ex-payer').value,
        amount,
        splits,
        splitMode: draft.mode,
        splitInput: draft.mode === 'percent' ? { percent: Object.assign({}, draft.percent) } : {},
        createdAt: expenseDate(editingId ? state.expenses.find((e) => e.id === editingId).createdAt : null),
      };
      commit((s) => {
        const i = s.expenses.findIndex((e) => e.id === record.id);
        if (i >= 0) s.expenses[i] = record;
        else s.expenses.push(record);
      });
      exDialog.close();
      toast(editingId ? 'Expense updated' : `${record.description} added`);
    } catch (e) {
      err.textContent = humanError(e);
    }
  });

  // ---------- payment dialog ----------

  const payDialog = $('#pay-dialog');
  const payForm = $('#pay-form');

  function openPayment(prefill) {
    if (state.members.length < 2) return;
    const opts = state.members.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    $('#pay-from').innerHTML = opts;
    $('#pay-to').innerHTML = opts;
    $('#pay-from').value = prefill ? prefill.from : state.members[0].id;
    $('#pay-to').value = prefill ? prefill.to : state.members[1].id;
    $('#pay-amount').value = prefill ? (prefill.amount / 100).toFixed(2) : '';
    $('#pay-note').value = '';
    $('#pay-error').textContent = '';
    payDialog.showModal();
    setTimeout(() => $('#pay-amount').focus(), 30);
  }

  payForm.addEventListener('input', () => { $('#pay-error').textContent = ''; });
  payForm.addEventListener('submit', (ev) => {
    if (ev.submitter && ev.submitter.value === 'cancel') return;
    ev.preventDefault();
    const amount = parseRupees($('#pay-amount').value);
    if (amount === null) {
      $('#pay-error').textContent = 'Enter an amount like 450 or 450.50.';
      return;
    }
    if ($('#pay-from').value === $('#pay-to').value) {
      $('#pay-error').textContent = 'Choose two different people.';
      return;
    }
    const record = {
      id: uid('s'),
      from: $('#pay-from').value,
      to: $('#pay-to').value,
      amount,
      note: $('#pay-note').value.trim(),
      createdAt: new Date().toISOString(),
    };
    try {
      commit((s) => s.settlements.push(record));
      payDialog.close();
      toast(`${nameOf(record.from)} paid ${nameOf(record.to)} ${formatPaise(amount)}`);
    } catch (e) {
      $('#pay-error').textContent = humanError(e);
    }
  });

  // close dialogs when clicking the backdrop
  for (const d of [exDialog, payDialog]) {
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
  }

  // ---------- demo ----------

  function loadDemo() {
    const ids = { asha: uid('m'), bilal: uid('m'), chen: uid('m'), dev: uid('m') };
    const everyone = Object.values(ids);
    const day = (d, h) => new Date(2026, 8, d, h).toISOString();
    const pct = { [ids.asha]: '25', [ids.bilal]: '25', [ids.chen]: '30', [ids.dev]: '20' };
    const demo = {
      groupName: 'Goa, September',
      members: [
        { id: ids.asha, name: 'Asha' },
        { id: ids.bilal, name: 'Bilal' },
        { id: ids.chen, name: 'Chen' },
        { id: ids.dev, name: 'Dev' },
      ],
      expenses: [
        { id: uid('e'), description: 'Villa in Assagao', paidBy: ids.asha, amount: 2400000, splits: splitEqually(2400000, everyone), splitMode: 'equal', splitInput: {}, createdAt: day(19, 10) },
        { id: uid('e'), description: 'Scooter rentals', paidBy: ids.bilal, amount: 360000, splits: splitEqually(360000, [ids.bilal, ids.chen, ids.dev]), splitMode: 'equal', splitInput: {}, createdAt: day(20, 9) },
        { id: uid('e'), description: 'Seafood dinner', paidBy: ids.chen, amount: 543750,
          splits: splitByPercentage(543750, everyone.map((id) => ({ memberId: id, percent: Number(pct[id]) }))),
          splitMode: 'percent', splitInput: { percent: pct }, createdAt: day(21, 21) },
        { id: uid('e'), description: 'Groceries & snacks', paidBy: ids.dev, amount: 199999, splits: splitEqually(199999, everyone), splitMode: 'equal', splitInput: {}, createdAt: day(22, 12) },
        { id: uid('e'), description: 'Parasailing', paidBy: ids.asha, amount: 450000,
          splits: splitExact(450000, [{ memberId: ids.asha, amount: 150000 }, { memberId: ids.bilal, amount: 150000 }, { memberId: ids.dev, amount: 150000 }]),
          splitMode: 'exact', splitInput: {}, createdAt: day(23, 15) },
      ],
      settlements: [{ id: uid('s'), from: ids.dev, to: ids.asha, amount: 300000, note: 'UPI', createdAt: day(24, 11) }],
    };
    // The demo becomes its own group; it fills the current group only if that one is still empty.
    if (!hasContent(state) && !state.loading) {
      commit((s) => Object.assign(s, demo));
    } else {
      const group = Object.assign(newGroup(), demo, { rev: 1 }); // rev 1 → not yet synced
      calculateBalances(group);
      store.groups.push(group);
      switchGroup(group.id);
      sync(group.id);
    }
    toast('Demo trip added to your groups');
  }

  // ---------- groups ----------

  const groupsDialog = $('#groups-dialog');
  let renamingId = null;

  function groupSummary(g) {
    const spent = g.expenses.reduce((a, e) => a + e.amount, 0);
    const people = plural(g.members.length, 'person').replace('persons', 'people');
    return `${people} · ${plural(g.expenses.length, 'expense')}${spent ? ' · ' + formatPaise(spent) : ''}`;
  }

  function groupInitials(name) {
    const words = name.trim().split(/[\s,]+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  }

  function renderGroupButton() {
    $('#groups-current').textContent = state.groupName;
    $('#groups-count').textContent = store.groups.length;
  }

  function renderGroupList() {
    const PEN = '<svg viewBox="0 0 20 20"><path d="M12.5 4.5l3 3L7 16H4v-3z"/></svg>';
    const BIN = '<svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2m-6 0 .7 10h6.6L14 6"/></svg>';
    const PDF = '<svg viewBox="0 0 20 20"><path d="M10 3v9m-4-4 4 4 4-4M4 14v2.5h12V14"/></svg>';
    $('#group-list').innerHTML = store.groups
      .map((g, i) => {
        const id = esc(g.id);
        const name = esc(g.groupName);
        const active = g.id === state.id;
        const [bg, fg] = AVATAR_TONES[i % AVATAR_TONES.length];
        const badge = `<span class="group-badge" style="background:${bg};color:${fg}">${esc(groupInitials(g.groupName))}</span>`;
        const pill = active ? '<span class="pill">Current</span>' : '';
        const body =
          g.id === renamingId
            ? `<div class="group-pick">${badge}<span class="group-info">
                 <input class="group-rename" data-rename-input="${id}" value="${name}" maxlength="40" aria-label="Group name">
                 <small>${groupSummary(g)}</small></span></div>`
            : `<button class="group-pick" type="button" data-pick="${id}">${badge}<span class="group-info">
                 <strong>${name}</strong><small>${groupSummary(g)}</small></span>${pill}</button>`;
        return `<li class="group-row${active ? ' active' : ''}">${body}
          <div class="group-tools">
            <button class="icon-btn" type="button" data-export-group="${id}" aria-label="Download statement (PDF) for ${name}" title="Download statement (PDF)">${PDF}</button>
            <button class="icon-btn" type="button" data-rename="${id}" aria-label="Rename ${name}">${PEN}</button>
            <button class="icon-btn" type="button" data-delete-group="${id}" aria-label="Delete ${name}">${BIN}</button>
          </div></li>`;
      })
      .join('');
    const input = $('#group-list [data-rename-input]');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function openGroups() {
    renamingId = null;
    renderGroupList();
    groupsDialog.showModal();
  }

  function finishRename(keep) {
    const input = $('#group-list [data-rename-input]');
    const id = renamingId;
    if (!id || !input) return;
    renamingId = null; // set first: re-rendering fires focusout on the old input
    const name = input.value.trim().replace(/\s+/g, ' ');
    if (keep && name) commit((g) => { g.groupName = name; }, id);
    renderGroupList();
  }

  function deleteGroup(id) {
    const index = store.groups.findIndex((g) => g.id === id);
    if (index < 0) return;
    const removed = store.groups[index];
    const removedOps = ops.get(id);
    store.groups.splice(index, 1);
    ops.delete(id);
    let placeholder = null;
    if (!store.groups.length) {
      placeholder = newGroup('My group');
      store.groups.push(placeholder);
    }
    if (state.id === id) switchGroup(store.groups[Math.min(index, store.groups.length - 1)].id);
    else { save(); render(); }
    renderGroupList();
    // The account copy is deleted after the Undo window closes.
    if (canSync() && removed.token && removed.owned) {
      pendingDeletes.set(id, { token: removed.token, timer: setTimeout(() => runDelete(id), 6500) });
    }
    toast(`${removed.groupName} deleted`, {
      label: 'Undo',
      run: () => {
        const pending = pendingDeletes.get(removed.id);
        if (pending) clearTimeout(pending.timer);
        pendingDeletes.delete(removed.id);
        const p = placeholder && store.groups.find((g) => g.id === placeholder.id);
        if (p && !p.members.length && !p.expenses.length && !p.settlements.length) store.groups.splice(store.groups.indexOf(p), 1);
        store.groups.splice(Math.min(index, store.groups.length), 0, removed);
        if (removedOps) ops.set(removed.id, removedOps);
        switchGroup(removed.id);
        sync(removed.id);
        if (groupsDialog.open) renderGroupList();
      },
    });
  }

  async function runDelete(id) {
    const pending = pendingDeletes.get(id);
    if (!pending || pending.running) return;
    pending.running = true;
    clearTimeout(pending.timer);
    try {
      if (canSync()) await remote.deleteGroup(session.token, pending.token);
    } catch (err) {
      if (err.signedOut) return handleSignedOut();
      console.warn('Splitter delete failed', err);
      toast('Could not delete that group from your account — it may reappear');
    } finally {
      pendingDeletes.delete(id); // only now may a refresh see the account list again
    }
  }

  /** Run any deletes still waiting out their Undo window (before signing out or leaving the page). */
  function flushDeletes() {
    return Promise.all([...pendingDeletes.entries()].map(([id, pending]) => {
      clearTimeout(pending.timer);
      return runDelete(id);
    }));
  }

  $('#group-list').addEventListener('click', (ev) => {
    const pick = ev.target.closest('[data-pick]');
    const rename = ev.target.closest('[data-rename]');
    const del = ev.target.closest('[data-delete-group]');
    const pdf = ev.target.closest('[data-export-group]');
    if (pdf) {
      exportStatement(findGroup(pdf.dataset.exportGroup));
    } else if (pick) {
      switchGroup(pick.dataset.pick);
      groupsDialog.close();
    } else if (rename) {
      if (renamingId === rename.dataset.rename) return finishRename(true);
      renamingId = rename.dataset.rename;
      renderGroupList();
    } else if (del) {
      deleteGroup(del.dataset.deleteGroup);
    }
  });

  $('#group-list').addEventListener('keydown', (ev) => {
    if (!ev.target.dataset.renameInput) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      finishRename(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault(); // keep the dialog open; just cancel the rename
      ev.stopPropagation();
      finishRename(false);
    }
  });

  $('#group-list').addEventListener('focusout', (ev) => {
    if (ev.target.dataset.renameInput && !(ev.relatedTarget && ev.relatedTarget.closest('[data-rename]'))) finishRename(true);
  });

  $('#new-group-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('#new-group-name');
    const name = input.value.trim().replace(/\s+/g, ' ') || 'New group';
    const g = newGroup(name);
    store.groups.push(g);
    switchGroup(g.id);
    input.value = '';
    groupsDialog.close();
    toast(`${name} created — add the people first`);
    setTimeout(() => $('#member-name').focus(), 50);
  });

  groupsDialog.addEventListener('click', (ev) => {
    if (ev.target === groupsDialog || ev.target.closest('[data-close]')) groupsDialog.close();
  });
  for (const d of [exDialog, payDialog, groupsDialog]) {
    d.addEventListener('close', () => document.body.appendChild($('#toasts')));
  }

  document.addEventListener('click', (ev) => { if (ev.target.closest('[data-demo]')) loadDemo(); });
  $('#btn-demo').addEventListener('click', loadDemo);
  $('#btn-groups').addEventListener('click', openGroups);
  $('#btn-add').addEventListener('click', () => openExpense(null));
  $('#btn-pay').addEventListener('click', () => openPayment(null));

  // ---------- sign in / account ----------

  const authDialog = $('#auth-dialog');
  const accountDialog = $('#account-dialog');
  let authMode = 'signin';

  const AUTH_ERRORS = {
    invalid_email: 'Enter a valid email address.',
    weak_password: 'Use at least 8 characters for the password.',
    email_taken: 'An account with this email already exists — sign in instead.',
    invalid_credentials: 'Wrong email or password.',
    account_locked: 'Too many wrong attempts. Try again in 15 minutes.',
  };

  function setAuthMode(mode) {
    authMode = mode;
    authDialog.querySelectorAll('[data-auth-mode]').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.authMode === mode));
    });
    $('#auth-title').textContent = mode === 'signup' ? 'Create your account' : 'Welcome back';
    $('#auth-confirm-field').hidden = mode !== 'signup';
    $('#auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    $('#auth-password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    $('#auth-error').textContent = '';
  }

  function openAuth(mode) {
    if (!remote) return;
    setAuthMode(mode || 'signin');
    $('#auth-password').value = '';
    $('#auth-confirm').value = '';
    if (!authDialog.open) authDialog.showModal();
    setTimeout(() => $('#auth-email').focus(), 30);
  }

  authDialog.addEventListener('click', (ev) => {
    const tab = ev.target.closest('[data-auth-mode]');
    if (tab) setAuthMode(tab.dataset.authMode);
    if (ev.target === authDialog || ev.target.closest('[data-close]')) authDialog.close();
  });

  $('#auth-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#auth-error');
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    err.textContent = '';
    if (authMode === 'signup' && password !== $('#auth-confirm').value) {
      err.textContent = 'The two passwords do not match.';
      return;
    }
    const btn = $('#auth-submit');
    btn.disabled = true;
    try {
      const res = authMode === 'signup' ? await remote.signUp(email, password) : await remote.signIn(email, password);
      if (res && res.error) {
        err.textContent = AUTH_ERRORS[res.error] || 'Could not sign in.';
        return;
      }
      authDialog.close();
      await completeSignIn(res);
    } catch (e) {
      err.textContent = /PGRST202|Could not find the function/.test(e.message)
        ? 'Accounts are not set up on the server yet (run supabase/schema.sql).'
        : 'Could not reach the server — check your connection.';
    } finally {
      btn.disabled = false;
    }
  });

  async function completeSignIn(res) {
    session = { token: res.session, email: res.email };
    saveSession();
    // Groups made on this device while signed out move into the account.
    const moving = store.groups.filter((g) => hasContent(g) && !g.owned).length;
    store.account = res.email;
    save();
    render();
    renderAccount();
    await refreshGroupList();
    for (const g of store.groups) if (needsSync(g)) sync(g.id);
    if (tokenFromHash()) openFromLink();
    toast(moving ? `Signed in — ${plural(moving, 'group')} from this device moved into your account` : `Signed in as ${res.email}`);
  }

  /** Forget the account on this device: its groups stay safe in the account, not in this browser. */
  function resetToSignedOut(message) {
    session = null;
    saveSession();
    ops.clear();
    store = freshStore(null);
    state = store.groups[0];
    save();
    history.replaceState(null, '', location.pathname + location.search);
    render();
    renderAccount();
    if (message) toast(message);
  }

  async function signOut() {
    const unsaved = store.groups.some((g) => needsSync(g) && (hasContent(g) || g.token));
    if (unsaved && !window.confirm('Some changes have not reached your account yet and will be lost. Sign out anyway?')) return;
    await flushDeletes();
    const token = session && session.token;
    accountDialog.close();
    resetToSignedOut('Signed out. Your groups are safe in your account.');
    if (token) remote.signOut(token).catch(() => {});
  }

  function handleSignedOut() {
    if (!session) return;
    resetToSignedOut('Your session ended — please sign in again');
    openAuth('signin');
  }

  function renderAccount() {
    const btn = $('#btn-account');
    btn.hidden = !remote;
    if (!remote) return;
    btn.classList.toggle('signed-in', !!session);
    $('#account-label').textContent = session ? session.email : 'Sign in';
    $('#account-initial').textContent = session ? session.email.charAt(0).toUpperCase() : '';
    btn.setAttribute('aria-label', session ? `Account: ${session.email}` : 'Sign in');
  }

  $('#btn-account').addEventListener('click', () => {
    if (!session) return openAuth('signin');
    $('#account-email').textContent = session.email;
    $('#pw-form').reset();
    $('#pw-form').hidden = true;
    $('#pw-error').textContent = '';
    accountDialog.showModal();
  });

  accountDialog.addEventListener('click', (ev) => {
    if (ev.target === accountDialog || ev.target.closest('[data-close]')) accountDialog.close();
    else if (ev.target.closest('#btn-signout')) signOut();
    else if (ev.target.closest('#btn-change-pw')) {
      $('#pw-form').hidden = false;
      $('#pw-old').focus();
    }
  });

  $('#pw-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#pw-error');
    err.textContent = '';
    if ($('#pw-new').value !== $('#pw-confirm').value) {
      err.textContent = 'The new passwords do not match.';
      return;
    }
    try {
      const res = await remote.changePassword(session.token, $('#pw-old').value, $('#pw-new').value);
      if (res && res.error) {
        err.textContent = res.error === 'invalid_credentials' ? 'Your current password is wrong.' : AUTH_ERRORS[res.error];
        return;
      }
      accountDialog.close();
      toast('Password changed. Your other devices were signed out.');
    } catch (e) {
      if (e.signedOut) return handleSignedOut();
      err.textContent = 'Could not reach the server — try again.';
    }
  });

  for (const d of [authDialog, accountDialog]) {
    d.addEventListener('close', () => document.body.appendChild($('#toasts')));
  }

  // ---------- person (name, emoji or photo) ----------

  const personDialog = $('#person-dialog');
  let personDraft = null; // { id, avatar }

  function renderPersonPreview() {
    const i = state.members.findIndex((m) => m.id === personDraft.id);
    const m = Object.assign({}, state.members[i], { name: $('#person-name').value.trim() || state.members[i].name, avatar: personDraft.avatar });
    $('#person-preview').innerHTML = avatarFor(m, i, false);
    personDialog.querySelectorAll('[data-emoji]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.emoji === (personDraft.avatar || '')));
    });
  }

  function openPerson(id) {
    const m = state.members.find((x) => x.id === id);
    if (!m) return;
    personDraft = { id, avatar: UI.avatarKind(m.avatar) ? m.avatar : '' };
    $('#person-name').value = m.name;
    $('#person-error').textContent = '';
    $('#person-emojis').innerHTML = [''].concat(UI.EMOJIS)
      .map((e) => e
        ? `<button type="button" class="emoji-btn" data-emoji="${esc(e)}" aria-label="Use ${esc(e)}">${esc(e)}</button>`
        : `<button type="button" class="emoji-btn initials" data-emoji="" aria-label="Use initials">Aa</button>`)
      .join('');
    renderPersonPreview();
    personDialog.showModal();
  }

  personDialog.addEventListener('click', (ev) => {
    if (ev.target === personDialog || ev.target.closest('[data-close]')) return personDialog.close();
    const pick = ev.target.closest('[data-emoji]');
    if (pick) {
      personDraft.avatar = pick.dataset.emoji;
      renderPersonPreview();
    }
  });
  $('#person-name').addEventListener('input', renderPersonPreview);

  $('#person-photo').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      personDraft.avatar = await UI.resizePhoto(file);
      $('#person-error').textContent = '';
      renderPersonPreview();
    } catch (err) {
      $('#person-error').textContent = err.message;
    }
  });

  $('#person-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const id = personDraft.id;
    const name = $('#person-name').value.trim().replace(/\s+/g, ' ');
    if (!name) return ($('#person-error').textContent = 'Give this person a name.');
    if (state.members.some((m) => m.id !== id && m.name.toLowerCase() === name.toLowerCase())) {
      return ($('#person-error').textContent = `${name} is already in the group.`);
    }
    const avatarValue = personDraft.avatar;
    commit((s) => {
      const m = s.members.find((x) => x.id === id);
      if (!m) return;
      m.name = name.slice(0, 24);
      if (UI.avatarKind(avatarValue)) m.avatar = avatarValue;
      else delete m.avatar;
    });
    personDialog.close();
  });

  personDialog.addEventListener('close', () => document.body.appendChild($('#toasts')));

  // ---------- theme (system / light / dark) ----------

  const THEME_KEY = 'splitter:theme';
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const effectiveTheme = () => document.documentElement.dataset.theme || (darkQuery && darkQuery.matches ? 'dark' : 'light');

  function applyTheme(choice) {
    if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
    try { choice === 'system' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, choice); } catch (_) { /* ignore */ }
    const current = (() => { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch (_) { return 'system'; } })();
    document.querySelectorAll('input[name=theme]').forEach((r) => { r.checked = r.value === current; });
    $('#btn-theme').setAttribute('aria-label', effectiveTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    $('#btn-theme').classList.toggle('is-dark', effectiveTheme() === 'dark');
  }

  $('#btn-theme').addEventListener('click', () => applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'));
  document.querySelectorAll('input[name=theme]').forEach((r) => r.addEventListener('change', () => applyTheme(r.value)));
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', () => applyTheme((() => { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch (_) { return 'system'; } })()));
  applyTheme((() => { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch (_) { return 'system'; } })());

  // ---------- start ----------

  render();
  renderAccount();

  if (remote) {
    window.addEventListener('hashchange', openFromLink);
    window.addEventListener('pagehide', () => { flushDeletes(); });
    if (session) {
      updateHash();
      // Upload anything left unsaved last time, then bring the list in line with the account.
      for (const g of store.groups) if (needsSync(g)) sync(g.id);
      refreshGroupList().then(openFromLink);
    } else {
      openFromLink();
    }
    // Pick up changes made on other devices; retry failed saves.
    const refresh = () => {
      if (!canSync()) return;
      for (const g of store.groups) if (!inflight.has(g.id) && needsSync(g)) sync(g.id); // even in background
      if (!document.hidden) refreshGroupList();
    };
    setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
  }
})();
