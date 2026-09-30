// Runs every test layer and (with --coverage) one merged coverage report.
//   npm test              unit + database + browser tests
//   npm run coverage      the same, plus coverage/index.html and a summary table
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const withCoverage = process.argv.includes('--coverage');
const V8_DIR = path.join(ROOT, 'coverage', '.v8-node');

if (withCoverage) fs.rmSync(path.join(ROOT, 'coverage'), { recursive: true, force: true });

function run(label, cmd, args, env = {}) {
  console.log(`\n━━ ${label} ━━`);
  // one command string (args are fixed, not user input), so the shell can expand the test globs
  const res = spawnSync([cmd, ...args].join(' '), { cwd: ROOT, stdio: ['inherit', 'pipe', 'inherit'], env: { ...process.env, ...env }, shell: true, encoding: 'utf8' });
  process.stdout.write(res.stdout || '');
  return { ok: res.status === 0, out: res.stdout || '' };
}

const nodeCount = (out) => {
  const n = (k) => Number((new RegExp(`ℹ ${k} (\\d+)`).exec(out) || [])[1] || 0);
  return { total: n('tests'), passed: n('pass'), failed: n('fail') };
};

const results = [];
const covEnv = withCoverage ? { NODE_V8_COVERAGE: V8_DIR } : {};

const unit = run('Unit tests (Node)', 'node', ['--test', '--test-reporter=spec', '"tests/*.test.js"', '"tests/unit/*.test.cjs"'], covEnv);
results.push(['Unit (Node)', nodeCount(unit.out), unit.ok]);

const db = run('Database tests (real schema.sql in PGlite)', 'node', ['--test', '--test-reporter=spec', '"tests/db/*.test.mjs"']);
results.push(['Database', nodeCount(db.out), db.ok]);

const e2e = run('Browser tests (Playwright + Chrome)', 'npx', ['playwright', 'test', '--reporter=list'], withCoverage ? { SPLITTER_COVERAGE: '1' } : {});
const passed = Number((/(\d+) passed/.exec(e2e.out) || [])[1] || 0);
const failed = Number((/(\d+) failed/.exec(e2e.out) || [])[1] || 0);
results.push(['Browser (E2E)', { total: passed + failed, passed, failed }, e2e.ok]);

if (withCoverage) {
  console.log('\n━━ Coverage (unit + browser, merged) ━━');
  const { default: MCR } = await import('monocart-coverage-reports');
  const { coverageOptions } = await import('./coverage-options.mjs');
  const report = MCR(coverageOptions);
  await report.addFromDir(V8_DIR);
  const summary = await report.generate();
  const pct = (x) => `${x.pct.toFixed(1)}%`;
  console.log(`\nOverall — lines ${pct(summary.summary.lines)} · statements ${pct(summary.summary.statements)} · functions ${pct(summary.summary.functions)} · branches ${pct(summary.summary.branches)}`);
  console.log(`HTML report: ${path.join('coverage', 'index.html')}`);
}

console.log('\n━━ Summary ━━');
let allOk = true;
for (const [label, c, ok] of results) {
  allOk = allOk && ok;
  console.log(`${ok ? '✔' : '✖'} ${label.padEnd(16)} ${c.passed}/${c.total} passed${c.failed ? `, ${c.failed} failed` : ''}`);
}
const total = results.reduce((a, [, c]) => a + c.total, 0);
const pass = results.reduce((a, [, c]) => a + c.passed, 0);
console.log(`${allOk ? '✔' : '✖'} ${'All'.padEnd(16)} ${pass}/${total} passed`);
process.exitCode = allOk ? 0 : 1;
