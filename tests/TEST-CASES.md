# Splitter — test cases

Every automated test, grouped by layer. Generated from the test titles by
`node tests/make-test-cases.mjs`, so it always matches the code.
Run everything with `npm test`, or `npm run coverage` for the coverage report (`coverage/index.html`).

| Layer | Runs in | What it proves |
|---|---|---|
| Unit (U) | Node (`node --test`) | The money maths, category logic, Supabase client, PDF builder and UI helpers, in isolation |
| Database (D) | Node + PGlite (a real Postgres running `schema.sql`) | Accounts, privacy, validation, conflicts, avatars, upgrades, the example scripts |
| Browser (A–L) | Playwright + Chrome, against a test server running the real schema | The real website end to end: every screen, two devices syncing, offline, phone layout |

**Total: 144 test cases.**

## Unit — balance engine (`src/balances.js`)

`tests/balances.test.js` · 36 tests

| ID | Test case |
|---|---|
| U01 | equal splits › one person pays equally for three people |
| U02 | equal splits › payer included in split: own share creates no self-debt |
| U03 | equal splits › payer excluded from split: payer is owed the full amount |
| U04 | equal splits › member not in any expense stays at zero |
| U05 | equal splits › no transactions: everyone is settled |
| U06 | unequal splits › unequal exact splits |
| U07 | unequal splits › exact split that does not add up is rejected |
| U08 | unequal splits › percentage splits |
| U09 | unequal splits › percentage split with decimals uses largest remainder |
| U10 | unequal splits › percentages must total 100 and have at most two decimals |
| U11 | multiple transactions › multiple expenses accumulate and net pairwise |
| U12 | multiple transactions › order of transactions does not matter |
| U13 | settlements › full settlement clears that pair |
| U14 | settlements › partial settlement reduces the debt |
| U15 | settlements › overpaying flips the direction of the debt |
| U16 | settlements › everyone settling up leaves all balances at zero |
| U17 | editing history › deleting an expense equals never having added it |
| U18 | editing history › deleting the only expense returns everyone to zero |
| U19 | editing history › editing an expense equals entering the corrected one from scratch |
| U20 | editing history › recalculating twice gives identical results (no hidden state) |
| U21 | invalid amounts › zero expense amount is rejected |
| U22 | invalid amounts › negative expense amount is rejected |
| U23 | invalid amounts › fractional paise are rejected |
| U24 | invalid amounts › negative share is rejected even if the total matches |
| U25 | invalid amounts › a zero share is allowed |
| U26 | invalid amounts › zero, negative or self settlements are rejected |
| U27 | invalid amounts › unknown or duplicate members are rejected |
| U28 | invalid amounts › split builders reject zero or negative amounts |
| U29 | rounding with odd paise › ₹1.00 among three → 34 / 33 / 33 |
| U30 | rounding with odd paise › 1 paisa among three → one person carries it |
| U31 | rounding with odd paise › odd amount between two |
| U32 | rounding with odd paise › shares never differ by more than one paisa and always sum exactly |
| U33 | rounding with odd paise › many odd-paise expenses still balance to zero |
| U34 | randomised invariants › 500 random ledgers satisfy every invariant |
| U35 | money helpers › parseRupees converts text to integer paise without floats |
| U36 | money helpers › formatPaise renders Indian grouping |

## Unit — categories and summaries (`src/categories.js`)

`tests/categories.test.js` · 19 tests

| ID | Test case |
|---|---|
| U37 | guessing categories › common descriptions land in the right preset |
| U38 | guessing categories › an explicit category always wins over the guess |
| U39 | guessing categories › preset names match case-insensitively; custom names are trimmed and capped |
| U40 | monthly spend › months run first → last with empty months filled |
| U41 | monthly spend › totals are exact integer paise and add up |
| U42 | monthly spend › series are in fixed palette order and only include categories with spend |
| U43 | monthly spend › a category keeps its colour whatever else is present |
| U44 | monthly spend › only the most recent 12 months are shown |
| U45 | monthly spend › no expenses → no months, no series |
| U46 | daily spend › month labels carry the full year (not mistakable for a day) |
| U47 | daily spend › one bucket per day from the first to the last day with spend in that month |
| U48 | daily spend › days of the month add up to that month in the monthly view |
| U49 | daily spend › gap days are filled with zero; a month with no spend is empty |
| U50 | spend by person › paid = out of pocket; settlements are not spending |
| U51 | spend by person › share = each person’s portion; shares add up to total spent |
| U52 | spend by person › colour follows the person (member order), not the amount |
| U53 | spend by person › more than 8 people: the rest fold into one slice |
| U54 | custom categories › custom categories are listed in order of first use |
| U55 | custom categories › the first custom gets its own colour; later customs fold into Other |

## Unit — Supabase client (`src/remote.js`)

`tests/unit/remote.test.cjs` · 7 tests

| ID | Test case |
|---|---|
| U56 | no config, or a missing value → local-only mode (null) |
| U57 | project URL is accepted with or without trailing slash or /rest/v1 |
| U58 | publishable keys go only in apikey; legacy JWT anon keys also in Authorization |
| U59 | every call maps to the right function with named arguments |
| U60 | only deleteGroup uses keepalive (so it survives the page closing) |
| U61 | responses: JSON body returned, empty body → null |
| U62 | errors carry the server message and status; not_signed_in is flagged |

## Unit — PDF statement (`src/statement.js`)

`tests/unit/statement.test.cjs` · 5 tests

| ID | Test case |
|---|---|
| U63 | pdfText turns characters the PDF fonts lack into safe ones |
| U64 | file name is safe and dated |
| U65 | a full statement: all sections, balances, settle-up, category + month tables |
| U66 | an empty group still produces a statement with friendly messages |
| U67 | long groups flow onto more pages, each with a footer |

## Unit — UI helpers and chart maths (`src/ui.js`, `src/charts.js`)

`tests/unit/ui.test.cjs` · 9 tests

| ID | Test case |
|---|---|
| U68 | avatarKind accepts emoji and small raster photos only |
| U69 | every built-in emoji is a valid avatar |
| U70 | categoryIcon: a tinted SVG per preset, a tag for anything else |
| U71 | countTo animates with frames and lands exactly on the target |
| U72 | countTo jumps straight to the value with reduced motion, hidden tabs, or no change |
| U73 | confetti and animateOut do nothing when motion is reduced |
| U74 | shortRupees: axis labels in Indian units |
| U75 | niceScale: a round axis top covering the max, 4–5 gridlines |
| U76 | cssColor maps palette colours to theme variables, leaves others alone |

## Database — schema (`supabase/schema.sql`)

`tests/db/schema.test.mjs` · 14 tests

| ID | Test case |
|---|---|
| D01 | schema installs, and re-running it is safe |
| D02 | sign up: email normalised, 64-char session, validation errors returned |
| D03 | sign in: right/wrong password, same error for unknown email, whoami, sign out |
| D04 | five wrong passwords lock the account for 15 minutes (even the right password) |
| D05 | passwords and sessions are stored only as hashes |
| D06 | change password: needs the old one, signs out other devices, keeps this one |
| D07 | groups: create, save, read back, list — with category round-trip |
| D08 | privacy: another account cannot read, save, delete or claim your group |
| D09 | the database enforces the ledger rules even if a client is wrong |
| D10 | optimistic concurrency: a stale version is refused with version_conflict |
| D11 | avatars: emoji and small photos accepted; HTML, SVG and oversized images refused |
| D12 | the public key can only call the public functions — no tables, no internal helpers |
| D13 | deleting an account deletes its groups and everything in them |
| D14 | password reset from the file header works and unlocks the account |

## Database — upgrades and example scripts

`tests/db/upgrade-and-examples.test.mjs` · 5 tests

| ID | Test case |
|---|---|
| D15 | upgrade from share-links (v2): data kept, old anonymous functions removed, old group claimable once |
| D16 | upgrade from accounts (v3): accounts and groups kept, avatar column added |
| D17 | examples/add-person.sql and add-expense.sql work and bump the version |
| D18 | examples/sample-groups.sql: three groups into the account, exact balances, re-run safe |
| D19 | examples/sample-groups.sql with an unknown email: unowned groups with claim links |

## Browser — core flows (local mode)

`tests/e2e/core.spec.mjs` · 13 tests

| ID | Test case |
|---|---|
| C01 | first visit: empty state, then "Load demo trip" fills a group |
| C02 | members: add, duplicate refused, remove an unused one, blocked when in use |
| C03 | equal split rounds odd paise fairly (₹1.00 among 3 → 34/33/33) |
| C04 | payer excluded from an equal split is owed the whole amount |
| C05 | exact split: must add up; then balances follow the shares |
| C06 | percentage split: must total 100%, largest remainder handles paise |
| C07 | invalid amounts and missing date are refused with a message |
| C08 | edit an expense: balances recalculate from the corrected amount |
| C09 | delete an expense, then Undo brings it back |
| C10 | settle up: record the suggested payments until everyone is square |
| C11 | manual payment: amount and "to yourself" are validated |
| C12 | "Who owes whom" lists direct debts before simplifying |
| C13 | everything survives a reload (saved on this device) |

## Browser — groups, categories, charts, PDF

`tests/e2e/groups-insights.spec.mjs` · 7 tests

| ID | Test case |
|---|---|
| G01 | groups: create, switch, rename, and data stays separate |
| G02 | delete a group, then Undo; deleting the last group leaves a fresh one |
| G03 | categories: guessed from the description, overridable, custom names allowed |
| G04 | spending chart: monthly totals by category, then drill into a month by day |
| G05 | spending chart: "All groups" adds up every group |
| G06 | who spent what: Paid vs Share, both totalling what was spent |
| G07 | PDF statement downloads from the banner and from the Groups list |

## Browser — look and feel, phone, accessibility

`tests/e2e/look.spec.mjs` · 8 tests

| ID | Test case |
|---|---|
| L01 | theme: System → Dark → Light, remembered after reload, applied before paint |
| L02 | theme follows the system setting when on "System" |
| L03 | person editor: emoji, rename (duplicates refused), photo upload, back to initials |
| L04 | settling up plays confetti; numbers count up; new rows slide in |
| L05 | undoing into a settled state does not celebrate again |
| L06 | with reduced motion there is no confetti at all |
| L07 | phone layout: nothing scrolls sideways, header fits, dialogs fit |
| L08 | keyboard and labels: dialogs close on Escape, controls are named |

## Browser — accounts, privacy, sync

`tests/e2e/accounts-sync.spec.mjs` · 11 tests

| ID | Test case |
|---|---|
| A01 | sign-up form: mismatch, weak password, bad email, then success |
| A02 | groups made while signed out move into the new account |
| A03 | sign out clears this device; signing back in restores everything |
| A04 | five wrong passwords lock the account for a while |
| A05 | privacy: another account cannot open your group link; a signed-out visitor is asked to sign in |
| A06 | two devices, one account: a change on one appears on the other |
| A07 | simultaneous edits on two devices are both kept |
| A08 | offline: edits wait on the device and sync when the connection returns |
| A09 | deleting a group removes it from the account after the Undo window |
| A10 | changing the password signs your other devices out |
| A11 | avatars sync between devices |

## Browser — edge cases

`tests/e2e/edge-cases.spec.mjs` · 9 tests

| ID | Test case |
|---|---|
| E01 | reloading while signed in keeps you signed in with your groups |
| E02 | a group deleted on another device disappears here too |
| E03 | the same name added on two devices at once: the second is refused with a clear message |
| E04 | opening an old (pre-account) group link while signed in moves it into your account |
| E05 | "accounts not set up" is explained if the database script hasn't been run |
| E06 | editing an exact-split expense brings back its shares |
| E07 | group name: a blank name becomes "Untitled group"; Escape cancels a rename |
| E08 | data from the very first version (single group) is carried over |
| E09 | corrupted saved data is ignored instead of breaking the page |

## Browser — unit suites in real Chrome

`tests/e2e/browser-unit.spec.mjs` · 1 test

| ID | Test case |
|---|---|
| B01 | unit suites pass in the browser too (tests/index.html) |
