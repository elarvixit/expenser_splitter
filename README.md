# Splitter — expense splitter

A static web app for splitting group expenses to the paisa. No build step and no npm packages.
The PDF library is loaded from cdnjs only when you export.

```
index.html, styles.css, app.js   UI (orange/white): state, sync, sign-in
src/balances.js                  pure balance engine (browser global + CommonJS)
src/categories.js                categories, guessing from descriptions, monthly totals (pure)
src/charts.js                    monthly spend chart (SVG), legend and table view
src/statement.js                 PDF statement (jsPDF + autotable, pinned with SRI)
src/remote.js                    tiny Supabase client (calls the splitter_* database functions)
config.js                        public Supabase URL + anon key (empty = local-only mode)
supabase/schema.sql              tables + functions; paste into the Supabase SQL Editor
supabase/examples/*.sql          adding people / expenses by hand
tests/*.test.js                  unit tests (browser or Node)
tests/index.html                 browser test runner
serve.ps1                        tiny local static server (PowerShell)
scripts/write-config.mjs         Vercel build step: config.js from environment variables
vercel.json                      runs that step on deploy
```

## Run

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Open http://localhost:5173 for the app and http://localhost:5173/tests/ for the tests.
With Node installed you can also run `node tests/balances.test.js` and `node tests/categories.test.js`.

## Features

- **Groups:** create, switch, rename and delete them from the **Groups** button.
- **Accounts:** email + password. Each account sees only its own groups, synced on every device.
  Signed out, Splitter still works, but data stays in that browser.
- **Categories:** Food, Travel, Stay, Shopping, Entertainment, Bills, Other, or your own. Older
  expenses without one get a guess from their description ("Biryani" → Food).
- **Spending chart:** monthly spend stacked by category, for the open group or all your groups,
  with a legend, hover/focus tooltips and a table view. Expenses have a date, so past months can
  be entered.
- **PDF statement:** **Export PDF** downloads the open group's balances, settle-up plan,
  spending by category and month, every expense and every payment. The PDF fonts have no ₹ sign,
  so amounts there read "Rs.".

## Supabase (accounts and sync)

With no Supabase settings, Splitter keeps data only in the browser. To turn on accounts:

1. In your Supabase project, open **SQL Editor → New query**, paste all of
   `supabase/schema.sql` and click **Run**. It's safe to run again, and data is kept. It works in
   a new project or in a shared team project, because everything it creates is prefixed:
   - tables: `tharun_expense_splitter_users`, `_sessions`, `_groups`, `_members`, `_expenses`,
     `_expense_splits`, `_settlements`
   - functions: `splitter_*`

   It uses the `pgcrypto` extension, which Supabase provides, for password hashing. It does **not**
   use Supabase Auth, so the project's other users and auth settings are untouched. The top of the
   file has the commands to reset a forgotten password and to remove the app.
2. Give the site the **Project URL** and the **publishable / anon key** (Project Settings → API).
   Use either of these:
   - **Vercel environment variables** (Project → Settings → Environment Variables):
     `SUPABASE_URL` and `SUPABASE_ANON_KEY`, then redeploy. On each deploy,
     `scripts/write-config.mjs` writes them into `config.js`. The names created by Vercel's Supabase
     integration (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `…_PUBLISHABLE_KEY`) also work. Secret / service_role keys are refused.
   - **`config.js`**: put them in the file directly. This is also what local development uses.
3. Open the site and **Sign in → Create account**. Groups already on that device move into the
   account. A group made before accounts existed can be claimed by opening its old `#g=` link
   while signed in; after that it's private to that account.

How it stays safe with a public key:
- The tables have Row Level Security on with no policies, and the anon role has no table privileges.
- The browser can only call the `splitter_*` functions. Every group function takes a session token
  and only touches groups owned by that account.
- Passwords are stored as bcrypt hashes, and only a SHA-256 hash of each session token is stored.
- Five wrong passwords lock an account for 15 minutes.
- Never use the `service_role` / secret key.

Edits apply instantly on the device, then sync. `splitter_account_save_group` checks a version
number. If another device saved in between, the app fetches the latest copy, replays your unsaved
changes on top of it and saves again. Changes from your other devices are picked up every 15
seconds and whenever you return to the tab. Deleting a group removes it from the account after
the Undo window.

## Data model

Only transactions are stored: in `localStorage` under `splitter:v2` on the device, and in the
account when signed in. Balances are never stored; every render calls
`calculateBalances({ members, expenses, settlements })` for the active group.

- Expense: `{ id, description, category?, paidBy, amount, splits: [{ memberId, amount }], createdAt }`,
  where all amounts are integer paise
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
