import { Window } from 'happy-dom';
import { adapterFor } from '../src/adapters/index';
import { HIDDEN_CLASS } from '../src/content/hider';
import { Scanner } from '../src/content/scanner';
import { siteKey } from '../src/storage/settings';
import { defaultContext } from '../src/messages';
import { DEFAULT_CATEGORIES, type CategoryToggles } from '../src/types';

// Runs the real content-script pipeline over one fixture page and compares what
// got hidden with the data-gold labels on each unit root. Shared by the eval
// runner (evals/run.ts) and the unit tests, so both judge the same thing.

export type Gold = 'sponsored' | 'suggested' | 'none';
/** gold is what the unit is; expected is whether this pass's categories should hide it. */
export type UnitResult = { gold: Gold; expected: boolean; hidden: boolean; snippet: string };

/** The two passes every fixture runs: out-of-the-box settings, and every category on. */
export const PASSES: { name: string; categories: CategoryToggles }[] = [
  { name: 'default', categories: DEFAULT_CATEGORIES },
  { name: 'all', categories: { sponsored: true, suggested: true, custom: true } },
];

function parseGold(v: string | null): Gold {
  return v === 'sponsored' || v === 'suggested' ? v : 'none';
}

export type FixtureResult = {
  file: string;
  host: string;
  adapter: string;
  units: UnitResult[];
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** Units the pipeline hid that carry no data-gold label at all: always a failure. */
  unlabelledHidden: string[];
};

export function evalFixture(file: string, html: string, categories: CategoryToggles = DEFAULT_CATEGORIES): FixtureResult {
  const hostMatch = /<meta\s+name="sifter-host"\s+content="([^"]+)"/.exec(html);
  if (!hostMatch?.[1]) throw new Error(`${file}: missing <meta name="sifter-host">`);
  const host = hostMatch[1];
  const url = `https://${host}/`;

  const window = new Window({
    url,
    settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableIframePageLoading: true },
  });
  try {
    const doc = window.document as unknown as Document;
    doc.write(html);

    const adapter = adapterFor(host);
    const scanner = new Scanner({
      doc,
      hostname: host,
      baseUrl: url,
      adapter,
      context: defaultContext(siteKey(host), { categories: { ...categories } }),
      persistOverride: () => {},
      schedule: (fn) => fn(), // synchronous: the whole page in one pass
    });
    scanner.scanNow();

    const units: UnitResult[] = [];
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const el of Array.from(doc.querySelectorAll('[data-gold]'))) {
      const gold = parseGold(el.getAttribute('data-gold'));
      const expected = gold !== 'none' && categories[gold];
      const hidden = el.classList.contains(HIDDEN_CLASS);
      if (expected) hidden ? tp++ : fn++;
      else hidden ? fp++ : tn++;
      units.push({ gold, expected, hidden, snippet: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) });
    }
    const unlabelledHidden = Array.from(doc.querySelectorAll(`.${HIDDEN_CLASS}:not([data-gold])`)).map((el) =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
    );
    return { file, host, adapter: adapter?.id ?? 'generic', units, tp, fp, fn, tn, unlabelledHidden };
  } finally {
    void window.happyDOM.close();
  }
}

export function passes(r: FixtureResult): boolean {
  return r.fp === 0 && r.fn === 0 && r.unlabelledHidden.length === 0 && r.tp > 0;
}
