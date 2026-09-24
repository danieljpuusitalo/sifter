import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADAPTERS, adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { defaultContext } from '../../src/messages';
import { parseSettings, siteKey, siteOffRules } from '../../src/storage/settings';

// Per-site switches for each kind of suggestion ("Groups you're not in", "Reels").
// Each test turns one rule off and checks that its units stay while the others go,
// so a rule that silently stopped matching fails here instead of passing.

const ON = { sponsored: true, suggested: true, custom: true };

function scan(fixture: string, host: string, offRules: string[]) {
  const html = readFileSync(`fixtures/public/${fixture}`, 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>')).replace(/^<body[^>]*>/, '');
  const scanner = new Scanner({
    doc: document,
    hostname: host,
    baseUrl: `https://${host}/`,
    adapter: adapterFor(host),
    context: defaultContext(siteKey(host), { categories: ON, offRules }),
    persistOverride: () => undefined,
    schedule: (fn) => fn(),
  });
  scanner.scanNow();
  return scanner;
}
const hidden = (sel: string) => document.querySelector(sel)!.classList.contains(HIDDEN_CLASS);
const fb = (n: number) => `[aria-posinset="${n}"]`;

describe('adapter suggested rules', () => {
  it('have unique ids, and every block names a rule that exists', () => {
    for (const a of ADAPTERS) {
      const ids = (a.suggested?.rules ?? []).map((r) => r.id);
      expect(new Set(ids).size, a.id).toBe(ids.length);
      for (const b of a.blocks) if (b.rule) expect(ids, `${a.id}: ${b.selector}`).toContain(b.rule);
      for (const r of a.suggested?.rules ?? []) {
        for (const sel of r.selectors) expect(() => document.querySelectorAll(sel), `${a.id}/${r.id}: ${sel}`).not.toThrow();
      }
    }
  });
});

describe('Facebook: one switch per kind of suggestion', () => {
  const GROUPS = [7, 8, 10];
  const FOLLOW = [5, 11];
  const REELS = [9];
  const OTHERS = [6, 12];
  const expectHidden = (on: number[], off: number[]) => {
    for (const n of on) expect(hidden(fb(n)), `unit ${n} hidden`).toBe(true);
    for (const n of off) expect(hidden(fb(n)), `unit ${n} shown`).toBe(false);
  };

  it('positive control: every rule on hides every suggestion', () => {
    scan('facebook-feed.html', 'www.facebook.com', []);
    expectHidden([...GROUPS, ...FOLLOW, ...REELS], OTHERS);
  });
  it('"groups" off keeps group posts, the groups carousel and group suggestions', () => {
    scan('facebook-feed.html', 'www.facebook.com', ['groups']);
    expectHidden([...FOLLOW, ...REELS], [...GROUPS, ...OTHERS]);
  });
  it('"reels" off keeps the Reels module only', () => {
    scan('facebook-feed.html', 'www.facebook.com', ['reels']);
    expectHidden([...GROUPS, ...FOLLOW], [...REELS, ...OTHERS]);
  });
  it('"follow" off keeps page posts, in any language', () => {
    scan('facebook-feed.html', 'www.facebook.com', ['follow']);
    expectHidden([...GROUPS, ...REELS], [...FOLLOW, ...OTHERS]);
  });
  it('switching a rule back on hides again (re-decide on context change)', () => {
    const s = scan('facebook-feed.html', 'www.facebook.com', ['groups']);
    expect(hidden(fb(8))).toBe(false);
    s.applyContext(defaultContext('facebook.com', { categories: ON, offRules: [] }));
    s.scanNow();
    expect(hidden(fb(8))).toBe(true);
    s.applyContext(defaultContext('facebook.com', { categories: ON, offRules: ['groups'] }));
    s.scanNow();
    expect(hidden(fb(8))).toBe(false);
  });
  it('reports each rule and whether it is on, for the popup', () => {
    const s = scan('facebook-feed.html', 'www.facebook.com', ['reels']);
    expect(s.state().rules.map((r) => [r.id, r.on])).toEqual([
      ['groups', true],
      ['follow', true],
      ['reels', false],
    ]);
  });
});

describe('Instagram: accounts and the people module are separate', () => {
  const module = 'main div[data-gold="suggested"]';
  const articles = () => [...document.querySelectorAll('article[data-gold="suggested"]')];

  it('"people" off keeps the people module, still hides posts from strangers', () => {
    scan('instagram-feed.html', 'www.instagram.com', ['people']);
    expect(hidden(module)).toBe(false);
    expect(articles().length).toBeGreaterThan(0);
    for (const a of articles()) expect(a.classList.contains(HIDDEN_CLASS)).toBe(true);
  });
  it('"accounts" off keeps posts from strangers, still hides the module', () => {
    scan('instagram-feed.html', 'www.instagram.com', ['accounts']);
    expect(hidden(module)).toBe(true);
    for (const a of articles()) expect(a.classList.contains(HIDDEN_CLASS)).toBe(false);
  });
});

describe('LinkedIn: "likes this" activity is its own switch', () => {
  const wrap = (inner: string) => `<div data-testid="mainFeed">${inner}</div>`;
  const card = (id: string, top: string, button = '') =>
    `<div id="${id}" role="listitem" componentkey="update-card-focus-${id}"><p componentkey="s"><span>${top}</span></p><button></button><button></button><p componentkey="n"><span>Timo Aalto</span></p>${button}<p componentkey="b"><span>Body.</span></p></div>`;
  const page = wrap(card('liked', 'Ella Norr likes this') + card('stranger', 'Rune Dahl', '<button><span>Follow</span></button>'));
  const run = (offRules: string[]) => {
    document.body.innerHTML = page;
    new Scanner({
      doc: document,
      hostname: 'www.linkedin.com',
      baseUrl: 'https://www.linkedin.com/',
      adapter: adapterFor('www.linkedin.com'),
      context: defaultContext('linkedin.com', { categories: ON, offRules }),
      persistOverride: () => undefined,
      schedule: (fn) => fn(),
    }).scanNow();
  };

  it('positive control: both hide with every rule on', () => {
    run([]);
    expect(hidden('#liked')).toBe(true);
    expect(hidden('#stranger')).toBe(true);
  });
  it('"activity" off keeps the liked post, not the stranger', () => {
    run(['activity']);
    expect(hidden('#liked')).toBe(false);
    expect(hidden('#stranger')).toBe(true);
  });
  it('"follow" off keeps the stranger, not the liked post', () => {
    run(['follow']);
    expect(hidden('#liked')).toBe(true);
    expect(hidden('#stranger')).toBe(false);
  });
});

describe('settings: off rules per site', () => {
  it('reads only what was switched off, per site', () => {
    const s = parseSettings({ sites: { 'facebook.com': { rules: { groups: false } } } });
    expect(siteOffRules(s, 'facebook.com')).toEqual(['groups']);
    expect(siteOffRules(s, 'instagram.com')).toEqual([]);
  });
  it('a bad rules value costs that field, not the site', () => {
    const s = parseSettings({ sites: { 'facebook.com': { enabled: false, rules: { groups: 'nope' } } } });
    expect(s.sites['facebook.com']?.enabled).toBe(false);
    expect(siteOffRules(s, 'facebook.com')).toEqual([]);
  });
});
