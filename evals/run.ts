import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalFixture, passes, type FixtureResult } from './fixture-eval';

// Eval runner. M1 is tier 0 only, so every provider gives the same result; the
// flag exists so CI already calls the command the later milestones extend.
//   pnpm eval:mock                      public fixtures, mock provider
//   tsx evals/run.ts --fixtures private private captures (gitignored)

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
}
const provider = arg('provider', 'mock');
const set = arg('fixtures', 'public');
if (provider !== 'mock') {
  console.error(`provider "${provider}" is not available until M2; use --provider mock`);
  process.exit(2);
}

const dir = join('fixtures', set);
const files = readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
if (files.length === 0) {
  console.error(`no fixtures in ${dir}`);
  process.exit(2);
}

const results: FixtureResult[] = files.map((f) => evalFixture(f, readFileSync(join(dir, f), 'utf8')));

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
console.log(`provider=${provider} fixtures=${set}\n`);
console.log('file                      adapter    units  tp  fp  fn  precision  recall');
for (const r of results) {
  console.log(
    `${r.file.padEnd(26)}${r.adapter.padEnd(11)}${String(r.units.length).padStart(5)}${String(r.tp).padStart(4)}${String(r.fp).padStart(4)}${String(r.fn).padStart(4)}  ${pct(r.tp, r.tp + r.fp).padStart(9)}  ${pct(r.tp, r.tp + r.fn).padStart(6)}`,
  );
  for (const u of r.units) {
    if (u.gold === 'none' && u.hidden) console.log(`    FALSE HIDE   ${u.snippet}`);
    if (u.gold === 'sponsored' && !u.hidden) console.log(`    MISSED AD    ${u.snippet}`);
  }
  for (const s of r.unlabelledHidden) console.log(`    HID UNLABELLED ELEMENT  ${s}`);
}

const tot = results.reduce((a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, fn: a.fn + r.fn }), { tp: 0, fp: 0, fn: 0 });
console.log(`\ntotal: tp=${tot.tp} fp=${tot.fp} fn=${tot.fn}  precision=${pct(tot.tp, tot.tp + tot.fp)}  recall=${pct(tot.tp, tot.tp + tot.fn)}`);

mkdirSync(join('evals', 'results'), { recursive: true });
const out = join('evals', 'results', `${set}-${provider}.json`);
writeFileSync(out, JSON.stringify({ provider, fixtures: set, totals: tot, results }, null, 2) + '\n');
console.log(`wrote ${out}`);

// Tier 0 must be exact on fixtures: any organic unit hidden or any ad missed fails.
const ok = results.every(passes);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
