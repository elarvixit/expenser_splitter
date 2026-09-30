// Regenerates tests/TEST-CASES.md from the test titles:  node tests/make-test-cases.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TEST_RE = /^\s*test\('((?:[^'\\]|\\.)*)'/gm;

const titles = (file) => [...read(file).matchAll(TEST_RE)].map((m) => m[1].replace(/\\'/g, "'"));
function harness(file) { // the self-contained suites use group(...) + test(...)
  const out = [];
  let g = '';
  for (const m of read(file).matchAll(/^\s*(group|test)\('((?:[^'\\]|\\.)*)'/gm)) {
    if (m[1] === 'group') g = m[2];
    else out.push(`${g} › ${m[2].replace(/\\u2019/g, '’')}`);
  }
  return out;
}

const sections = [
  ['Unit — balance engine (`src/balances.js`)', 'tests/balances.test.js', harness('tests/balances.test.js'), 'U'],
  ['Unit — categories and summaries (`src/categories.js`)', 'tests/categories.test.js', harness('tests/categories.test.js'), 'U'],
  ['Unit — Supabase client (`src/remote.js`)', 'tests/unit/remote.test.cjs', titles('tests/unit/remote.test.cjs'), 'U'],
  ['Unit — PDF statement (`src/statement.js`)', 'tests/unit/statement.test.cjs', titles('tests/unit/statement.test.cjs'), 'U'],
  ['Unit — UI helpers and chart maths (`src/ui.js`, `src/charts.js`)', 'tests/unit/ui.test.cjs', titles('tests/unit/ui.test.cjs'), 'U'],
  ['Database — schema (`supabase/schema.sql`)', 'tests/db/schema.test.mjs', titles('tests/db/schema.test.mjs'), 'D'],
  ['Database — upgrades and example scripts', 'tests/db/upgrade-and-examples.test.mjs', titles('tests/db/upgrade-and-examples.test.mjs'), 'D'],
  ['Browser — core flows (local mode)', 'tests/e2e/core.spec.mjs', titles('tests/e2e/core.spec.mjs')],
  ['Browser — groups, categories, charts, PDF', 'tests/e2e/groups-insights.spec.mjs', titles('tests/e2e/groups-insights.spec.mjs')],
  ['Browser — look and feel, phone, accessibility', 'tests/e2e/look.spec.mjs', titles('tests/e2e/look.spec.mjs')],
  ['Browser — accounts, privacy, sync', 'tests/e2e/accounts-sync.spec.mjs', titles('tests/e2e/accounts-sync.spec.mjs')],
  ['Browser — edge cases', 'tests/e2e/edge-cases.spec.mjs', titles('tests/e2e/edge-cases.spec.mjs')],
  ['Browser — unit suites in real Chrome', 'tests/e2e/browser-unit.spec.mjs', titles('tests/e2e/browser-unit.spec.mjs')],
];

const total = sections.reduce((a, s) => a + s[2].length, 0);
const counters = { U: 0, D: 0 };
let md = `# Splitter — test cases

Every automated test, grouped by layer. Generated from the test titles by
\`node tests/make-test-cases.mjs\`, so it always matches the code.
Run everything with \`npm test\`, or \`npm run coverage\` for the coverage report (\`coverage/index.html\`).

| Layer | Runs in | What it proves |
|---|---|---|
| Unit (U) | Node (\`node --test\`) | The money maths, category logic, Supabase client, PDF builder and UI helpers, in isolation |
| Database (D) | Node + PGlite (a real Postgres running \`schema.sql\`) | Accounts, privacy, validation, conflicts, avatars, upgrades, the example scripts |
| Browser (A–L) | Playwright + Chrome, against a test server running the real schema | The real website end to end: every screen, two devices syncing, offline, phone layout |

**Total: ${total} test cases.**
`;
for (const [title, file, list, kind] of sections) {
  md += `\n## ${title}\n\n\`${file}\` · ${list.length} test${list.length === 1 ? '' : 's'}\n\n| ID | Test case |\n|---|---|\n`;
  for (const t of list) {
    const m = /^([A-Z]\d{2}) (.*)$/.exec(t);
    const id = m ? m[1] : `${kind}${String(++counters[kind]).padStart(2, '0')}`;
    md += `| ${id} | ${(m ? m[2] : t).replace(/\|/g, '\\|')} |\n`;
  }
}
fs.writeFileSync(path.join(ROOT, 'tests/TEST-CASES.md'), md);
console.log(`tests/TEST-CASES.md: ${total} test cases (${sections.map((s) => s[2].length).join(' + ')})`);
