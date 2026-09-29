# Halve — expense splitter

A static web app for splitting group expenses to the paisa. No build step, no dependencies.

```
index.html, styles.css, app.js   UI (orange/white)
src/balances.js                  pure balance engine (browser global + CommonJS)
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

## Data model

Only transactions are stored (in `localStorage`). Balances are never stored; every render calls
`calculateBalances({ members, expenses, settlements })`.

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
