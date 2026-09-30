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

  const STORE_KEY = 'splitter:v2';
  const LEGACY_KEY = 'halve:v1'; // single-group data from the first version
  const $ = (sel) => document.querySelector(sel);
  // null when config.js has no Supabase settings → local-only mode
  const remote = window.SplitterRemote ? window.SplitterRemote.createRemote(window.SPLITTER_CONFIG) : null;

  // ---------- state ----------
  // store = { activeGroupId, groups: [group] }
  // group = { id, groupName, members, expenses, settlements, createdAt,
  //           token     – secret share token once the group exists in Supabase (else null)
  //           version   – server version this copy is based on
  //           rev       – local change counter; synced when rev === syncedRev }

  function newGroup(name) {
    return {
      id: uid('g'), groupName: name || 'New group', members: [], expenses: [], settlements: [],
      createdAt: new Date().toISOString(), token: null, version: 0, rev: 0, syncedRev: 0,
    };
  }

  function normalizeGroup(g) {
    g.token = g.token || null;
    g.version = Number.isInteger(g.version) ? g.version : 0;
    g.rev = Number.isInteger(g.rev) ? g.rev : 0;
    g.syncedRev = Number.isInteger(g.syncedRev) ? g.syncedRev : g.rev;
    delete g.loading;
    return g;
  }

  const hasContent = (g) => g.members.length > 0 || g.expenses.length > 0 || g.settlements.length > 0;

  function isValidGroup(g) {
    try {
      return !!g && typeof g.id === 'string' && Array.isArray(g.members) && Array.isArray(g.expenses) &&
        Array.isArray(g.settlements) && !!calculateBalances(g); // rejects corrupted ledgers
    } catch (_) {
      return false;
    }
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        const groups = (s && Array.isArray(s.groups) ? s.groups : []).filter(isValidGroup).map(normalizeGroup);
        if (groups.length) {
          const active = groups.some((g) => g.id === s.activeGroupId) ? s.activeGroupId : groups[0].id;
          return { activeGroupId: active, groups };
        }
      }
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const g = normalizeGroup(Object.assign(newGroup(), JSON.parse(legacy)));
        if (isValidGroup(g)) return { activeGroupId: g.id, groups: [g] };
      }
    } catch (_) { /* fall through to a fresh store */ }
    const g = newGroup('My group');
    return { activeGroupId: g.id, groups: [g] };
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_) { /* storage unavailable */ }
  }

  let store = loadStore();
  let state = store.groups.find((g) => g.id === store.activeGroupId); // the active group

  /** Apply a change to a copy of a group; only keep it if the ledger is still valid. */
  function commit(mutate, groupId = state.id) {
    const i = store.groups.findIndex((g) => g.id === groupId);
    if (i < 0) return;
    const next = JSON.parse(JSON.stringify(store.groups[i]));
    mutate(next);
    calculateBalances(next); // throws ValidationError if the change breaks the ledger
    next.rev += 1;
    store.groups[i] = next;
    if (next.id === state.id) state = next;
    save();
    render();
    if (remote) {
      pendingOps(next.id).push({ rev: next.rev, mutate }); // kept so it can be replayed on a conflict
      sync(next.id);
    }
  }

  function switchGroup(id) {
    const g = store.groups.find((x) => x.id === id);
    if (!g) return;
    store.activeGroupId = id;
    state = g;
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
  // Every change is applied locally first, then pushed with save_group(token, version, group).
  // If someone else saved in between, the server answers 'version_conflict': we fetch the
  // latest copy, replay our not-yet-saved changes on top of it and try again.

  const ops = new Map(); // groupId → [{ rev, mutate }] not yet confirmed by the server
  const inflight = new Map(); // groupId → promise of the running sync (syncs are serialized)
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
    });
    delete next.loading;
    calculateBalances(next); // never accept a ledger the engine rejects
    return next;
  }

  function sync(id, opts) {
    if (!remote) return Promise.resolve();
    const run = (inflight.get(id) || Promise.resolve())
      .then(() => pushGroup(id, opts || {}))
      .then(() => { offline = false; })
      .catch((err) => {
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
      let g = findGroup(id);
      if (!g || g.loading) return;
      if (!g.token) {
        if (!force && !hasContent(g)) return; // don't create empty groups on the server
        const token = await remote.createGroup(g.groupName);
        g = findGroup(id);
        if (!g) return;
        putGroup(Object.assign({}, g, { token, version: 0, syncedRev: -1 })); // -1 → must save contents
        if (id === state.id) updateHash();
        continue;
      }
      if (g.rev === g.syncedRev) return;
      const sentRev = g.rev;
      try {
        const version = await remote.saveGroup(g.token, g.version, payloadOf(g));
        const latest = findGroup(id);
        if (!latest) return;
        putGroup(Object.assign({}, latest, { version, syncedRev: sentRev }));
        ops.set(id, pendingOps(id).filter((op) => op.rev > sentRev));
      } catch (err) {
        if (/version_conflict/.test(err.message)) await rebase(id);
        else if (err.status === 400 || err.status === 409) await discardRejected(id, err);
        else throw err; // network / server trouble → retried later
      }
    }
  }

  /** The server refused our copy (e.g. a duplicate name added at the same time elsewhere). */
  async function discardRejected(id, err) {
    const g = findGroup(id);
    const server = await remote.getGroup(g.token);
    const latest = findGroup(id);
    if (!latest) return;
    if (!server) {
      // The group vanished from the server: re-create it (with a new link) from this copy.
      putGroup(Object.assign({}, latest, { token: null, version: 0, syncedRev: -1 }));
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
    const server = await remote.getGroup(g.token);
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
      toast('Someone else changed this group at the same time — some of your edits could not be applied');
    }
  }

  /** Refresh a group from the server if someone else changed it (skipped while we have unsaved edits). */
  async function pull(id) {
    if (!remote) return;
    const g = findGroup(id);
    if (!g || !g.token || inflight.has(id)) return;
    if (g.rev !== g.syncedRev && !g.loading) return; // our own unsaved edits win until they're pushed
    let server;
    try {
      server = await remote.getGroup(g.token);
      offline = false;
    } catch (err) {
      offline = true;
      renderSyncStatus();
      return;
    }
    const latest = findGroup(id);
    if (!latest || inflight.has(id)) return;
    if (!server) {
      if (latest.loading) {
        removeGroupLocally(id);
        toast('That group link is invalid or the group no longer exists');
      }
      return;
    }
    if (latest.rev !== latest.syncedRev) {
      if (latest.loading) { await rebase(id); sync(id); } // edits made while the link was loading
      return;
    }
    if (server.version === latest.version && !latest.loading) return renderSyncStatus();
    putGroup(fromServer(latest, server));
    if (id === state.id) render();
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

  function updateHash() {
    if (!remote) return;
    const url = state.token ? `#g=${state.token}` : location.pathname + location.search;
    if (location.hash !== (state.token ? `#g=${state.token}` : '')) history.replaceState(null, '', url);
  }

  /** Open the group in the URL (#g=<token>), adding it to this device's list if it's new. */
  function openFromLink() {
    const token = tokenFromHash();
    if (!remote || !token) return;
    let g = store.groups.find((x) => x.token === token);
    if (!g) {
      g = Object.assign(newGroup('Loading group…'), { token, version: -1, loading: true });
      // A first-time visitor's untouched starter group is just clutter next to the shared one.
      store.groups = store.groups.filter((x) => x.token || x.rev > 0 || hasContent(x));
      store.groups.push(g);
    }
    if (g.id !== state.id) switchGroup(g.id);
    else pull(g.id);
  }

  const shareUrl = (g) => `${location.origin}${location.pathname}#g=${g.token}`;

  async function shareGroup() {
    const id = state.id;
    if (!findGroup(id).token) {
      toast('Creating a share link…');
      await sync(id, { force: true });
    }
    const g = findGroup(id);
    if (!g || !g.token) return toast('Could not create a link — check your connection and try again');
    const url = shareUrl(g);
    if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: `${g.groupName} · Splitter`, url }); return; } catch (_) { /* fall back to copy */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied — anyone with it can view and edit this group');
    } catch (_) {
      window.prompt('Copy this link to share the group:', url);
    }
  }

  function renderSyncStatus() {
    const pill = $('#sync-status');
    $('#btn-share').hidden = !remote;
    pill.hidden = !remote;
    if (!remote) return;
    let cls = 'synced';
    let text = 'Synced';
    if (state.loading) [cls, text] = ['saving', 'Loading…'];
    else if (inflight.has(state.id)) [cls, text] = ['saving', 'Saving…'];
    else if (offline && (state.rev !== state.syncedRev || !state.token)) [cls, text] = ['offline', 'Offline — will retry'];
    else if (!state.token) [cls, text] = ['local', 'Only on this device'];
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
  function avatar(id, small) {
    const i = Math.max(0, state.members.findIndex((m) => m.id === id));
    const [bg, fg] = AVATAR_TONES[i % AVATAR_TONES.length];
    const initials = nameOf(id).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    return `<span class="avatar${small ? ' avatar-sm' : ''}" style="background:${bg};color:${fg}">${esc(initials)}</span>`;
  }

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
    $('#btn-add').disabled = state.members.length === 0;
    $('#btn-pay').disabled = state.members.length < 2;
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
      <div class="stat"><dt>Total spent</dt><dd>${formatPaise(spent)}</dd></div>
      <div class="stat"><dt>Outstanding</dt><dd>${formatPaise(outstanding)}</dd></div>
      <div class="stat"><dt>To settle</dt><dd>${plural(transfers.length, 'payment')}</dd></div>`;
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
        return `<li>
          ${avatar(m.id)}
          <div class="who"><strong>${esc(m.name)}</strong><small>Paid ${formatPaise(paid[m.id] || 0)}</small></div>
          <div class="bar" role="img" aria-label="${esc(m.name)} ${label} ${formatPaise(Math.abs(v))}">${v ? `<i class="${cls}" style="width:${width}%"></i>` : ''}</div>
          <div class="amt ${cls}"><small>${label}</small>${v ? formatPaise(Math.abs(v)) : '—'}</div>
        </li>`;
      })
      .join('');
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
    $('#members').innerHTML = state.members
      .map((m) => `<li>${avatar(m.id, true)}<span>${esc(m.name)}</span>
        <button class="icon-btn" type="button" data-remove="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">
          <svg viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"/></svg></button></li>`)
      .join('');
  }

  function describeSplit(e) {
    const n = e.splits.filter((s) => s.amount > 0).length;
    const mode = e.splitMode === 'exact' ? 'exact amounts' : e.splitMode === 'percent' ? 'by percentage' : 'equally';
    return `${esc(nameOf(e.paidBy))} paid · split ${mode} · ${plural(n, 'person').replace('persons', 'people')}`;
  }

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
      return;
    }
    list.innerHTML = items
      .map(({ kind, item }) => {
        if (kind === 'expense') {
          return `<li>
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
        return `<li>
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

  $('#members').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-remove]');
    if (!btn) return;
    const id = btn.dataset.remove;
    if (isReferenced(id)) {
      toast(`${nameOf(id)} is part of existing transactions — remove those first`);
      return;
    }
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

  function removeWithUndo(collection, id, message) {
    const index = state[collection].findIndex((x) => x.id === id);
    if (index < 0) return;
    const removed = state[collection][index];
    const groupId = state.id;
    commit((s) => { s[collection].splice(index, 1); });
    toast(message, {
      label: 'Undo',
      run: () => {
        try {
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
    renderSplitRows();
    exDialog.showModal();
    setTimeout(() => $('#ex-amount').focus(), 30);
  }

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
    if (t.id === 'ex-amount') {
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
    try {
      const splits = buildSplits(amount);
      const record = {
        id: editingId || uid('e'),
        description: $('#ex-desc').value.trim() || 'Expense',
        paidBy: $('#ex-payer').value,
        amount,
        splits,
        splitMode: draft.mode,
        splitInput: draft.mode === 'percent' ? { percent: Object.assign({}, draft.percent) } : {},
        createdAt: editingId ? state.expenses.find((e) => e.id === editingId).createdAt : new Date().toISOString(),
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
    const message = remote && removed.token
      ? `${removed.groupName} removed from this device. Anyone with its link can still open it`
      : `${removed.groupName} deleted`;
    toast(message, {
      label: 'Undo',
      run: () => {
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

  $('#group-list').addEventListener('click', (ev) => {
    const pick = ev.target.closest('[data-pick]');
    const rename = ev.target.closest('[data-rename]');
    const del = ev.target.closest('[data-delete-group]');
    if (pick) {
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
  $('#btn-share').addEventListener('click', shareGroup);

  render();

  if (remote) {
    openFromLink();
    updateHash();
    // Upload local groups that aren't on the server yet, and anything left unsaved last time.
    for (const g of store.groups) if (g.rev !== g.syncedRev || (!g.token && hasContent(g))) sync(g.id);
    pull(state.id);
    window.addEventListener('hashchange', openFromLink);
    // Pick up other people's changes: poll the open group, retry failed saves.
    const refresh = () => {
      for (const g of store.groups) if (!inflight.has(g.id) && g.rev !== g.syncedRev) sync(g.id); // even in background
      if (!document.hidden) pull(state.id);
    };
    setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
  }
})();
