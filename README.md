# Splitter — expense splitter

A static web app for splitting group expenses to the paisa. No build step, no dependencies.

```
index.html, styles.css, app.js   UI (orange/white)
src/balances.js                  pure balance engine (browser global + CommonJS)
src/remote.js                    tiny Supabase client (calls the three database functions)
config.js                        public Supabase URL + anon key (empty = local-only mode)
supabase/schema.sql              database tables + functions; paste into the Supabase SQL Editor
tests/balances.test.js           unit tests (browser or Node)
tests/index.html                 browser test runner
serve.ps1                        tiny local static server (PowerShell)
```

## Run

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Open http://localhost:5173 for the app and http://localhost:5173/tests/ for the tests.
If Node is installed you can also run `node tests/balances.test.js`.

## Supabase (sync and share by link)

With `config.js` left empty, Splitter keeps data only in the browser. To sync across devices
and share groups:

1. In your Supabase project, open **SQL Editor → New query**, paste all of
   `supabase/schema.sql` and click **Run**. It's safe to run again later. It works in a new project
   or in a shared team project: all tables go in a private `splitter` schema (not exposed through
   the API), and the only additions to `public` are three `splitter_`-prefixed functions. Nothing
   else in the project is changed. The top of the file has the two commands to remove it.
2. Copy the **Project URL** and the **anon / publishable key** from **Project Settings → API**
   into `config.js`, then commit and push. Vercel redeploys automatically, and no Vercel
   environment variables are needed.
3. Open the site. Your existing groups upload automatically. **Share link** copies a URL like
   `https://…/#g=<secret>`, and anyone who opens it can view and edit that group.

How it stays safe with a public key: the tables have Row Level Security on with no policies, and
the anon role has no table privileges. The browser can only call `splitter_create_group`,
`splitter_get_group` and `splitter_save_group`, and each one needs the group's secret token. Never put the `service_role`
key in `config.js`.

Edits apply instantly on the device, then sync. `save_group` checks a version number. If
someone else saved in between, the app fetches the latest copy, replays your unsaved changes on
top of it and saves again. Other people's changes are picked up every 15 seconds and whenever you
return to the tab. Removing a group from the Groups list only removes it from that device.

## Data model

You can keep several groups (trips, flatmates, …). Use the **Groups** button in the header to
create, switch, rename or delete them. Each group has its own members, expenses and payments.

Only transactions are stored (in `localStorage` under `splitter:v2`, as
`{ activeGroupId, groups: [...] }`). Balances are never stored; every render calls
`calculateBalances({ members, expenses, settlements })` for the active group.

- Expense: `{ id, paidBy, amount, splits: [{ memberId, amount }] }`, where all amounts are integer paise
- Settlement: `{ id, from, to, amount }`, meaning `from` handed `to` real money
- Result: `{ balances: { [memberId]: paise }, debts: [{ from, to, amount }] }`
  - positive balance: the member should receive money; negative balance: the member owes money

`splitEqually`, `splitExact` and `splitByPercentage` turn user input into explicit paise splits.
Leftover paise from equal splits go one each to the first people listed. Percentage splits use the
largest-remainder method on integer basis points.

## Invariants

1. **Integer paise only.** Every amount, share and balance is a safe integer. No floats are
   involved, so there is no rounding drift.
2. **Conservation.** Each expense's splits sum exactly to its amount, so the balances always sum
   to zero. Money is neither created nor lost.
3. **Ledger formula.** `balance(m) = paid(m) − owed shares(m) + settlements sent(m) − settlements received(m)`.
4. **Debts explain balances.** For each member, what they are owed minus what they owe across the
   pairwise debts equals their balance.
5. **Canonical pairwise debts.** A pair of members has at most one debt entry. Every entry has a
   positive amount, and nobody owes themselves (the payer's own share cancels out).
6. **Purity and history-independence.** The result depends only on the current set of transactions,
   not on their order or on how they got there. Deleting an expense gives the same result as never
   adding it. Editing an expense gives the same result as entering the corrected version from
   scratch. Inputs are never mutated.
7. **Valid inputs only.** Invalid transactions are rejected with a `ValidationError` instead of
   being partially applied: zero, negative or fractional amounts, negative shares, splits that
   don't add up, unknown or duplicate members, and payments to oneself.
8. **Fair rounding.** In an equal split, no two shares differ by more than 1 paisa.
9. **Settle-up closes the books.** Applying `suggestSettlements(balances)` brings every balance to
   zero, using at most (n − 1) transfers, where n is the number of members with a non-zero balance.

After every scenario, the test suite checks invariants 1–5, 6 (no mutation) and 9 automatically.
It also runs them against 500 randomly generated ledgers.
