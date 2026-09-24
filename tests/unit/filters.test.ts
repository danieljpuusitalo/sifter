import { describe, expect, it } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { AdapterSchema, type Adapter } from '../../src/adapters/schema';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { detectMarker, unitText } from '../../src/extract';
import { fingerprint, stableText } from '../../src/fingerprint';
import { defaultContext, type SiteContext } from '../../src/messages';
import { MAX_RULES, mutedWordHit, mutedWordPattern, parseRules, selectorsFor } from '../../src/rules/filters';
import { decideTier0 } from '../../src/rules/tier0';
import { siteKey } from '../../src/storage/settings';

const validCss = (s: string) => {
  try {
    document.querySelector(s);
    return true;
  } catch {
    return false;
  }
};

describe('muted words', () => {
  const p = mutedWordPattern(['crypto', 'Web3', ' ', 'a', 'c++', 'kärpänen']);
  it('matches whole words, case-insensitively', () => {
    expect(mutedWordHit('Big CRYPTO news', p)).toBe('CRYPTO');
    expect(mutedWordHit('into web3 again', p)).toBe('web3');
  });
  it('does not match inside a word', () => {
    expect(mutedWordHit('cryptography class', p)).toBeNull();
    expect(mutedWordHit('cryptocurrency', p)).toBeNull();
  });
  it('treats regex characters as text', () => expect(mutedWordHit('I write c++ daily', p)).toBe('c++'));
  it('knows non-ASCII letters are letters', () => {
    expect(mutedWordHit('yksi kärpänen', p)).toBe('kärpänen');
    expect(mutedWordHit('kärpänenkin', p)).toBeNull();
  });
  it('drops blank and one-letter words; empty list means no pattern', () => {
    expect(mutedWordHit('a b c', p)).toBeNull();
    expect(mutedWordPattern([' ', 'x'])).toBeNull();
  });
});

describe('element rules', () => {
  it('parses site and every-site rules, comments and errors', () => {
    const { rules, errors } = parseRules(
      ['! a comment', '', 'www.LinkedIn.com##.promo', '##aside.ad', 'no separator', 'bad site##.x', 'x.com##[[', 'x.com##'].join('\n'),
      validCss,
    );
    expect(rules).toEqual([
      { site: 'linkedin.com', selector: '.promo' },
      { site: '', selector: 'aside.ad' },
    ]);
    expect(errors.map((e) => e.line)).toEqual([5, 6, 7, 8]);
  });
  it('caps the number of rules', () => {
    const text = Array.from({ length: MAX_RULES + 5 }, (_, i) => `##.r${i}`).join('\n');
    const { rules, errors } = parseRules(text, validCss);
    expect(rules).toHaveLength(MAX_RULES);
    expect(errors).toHaveLength(5);
  });
  it('selectorsFor picks the site, its subdomains and every-site rules', () => {
    const { rules } = parseRules('reddit.com##.a\n##.b\nx.com##.c', validCss);
    expect(selectorsFor(rules, 'reddit.com')).toEqual(['.a', '.b']);
    expect(selectorsFor(rules, 'old.reddit.com')).toEqual(['.a', '.b']);
    expect(selectorsFor(rules, 'notreddit.com')).toEqual(['.b']);
  });
});

describe('fingerprints', () => {
  it('ignore counters that tick', () => {
    expect(stableText('Great post 12 likes 1.2K views 3h')).toBe(stableText('Great post 13 likes 1,3K views 4h'));
    expect(fingerprint('x.com', 'Post 5 comments')).toBe(fingerprint('x.com', 'Post 6 comments'));
  });
  it('still tell different posts apart', () => expect(fingerprint('x.com', 'Hello there')).not.toBe(fingerprint('x.com', 'Hello world')));
  it('unit text reads the same whether or not the unit is hidden', () => {
    document.body.innerHTML = '<div id="u"><p>Aino Virtanen</p><p>Product designer</p><div>Shipped it.</div></div>';
    const u = document.getElementById('u') as HTMLElement;
    const shown = unitText(u, null);
    u.style.setProperty('display', 'none', 'important');
    expect(unitText(u, null)).toBe(shown);
    expect(shown).toBe('Aino Virtanen Product designer Shipped it.');
  });
});

describe('site keys', () => {
  it('fold aliases into one site', () => {
    expect(siteKey('twitter.com')).toBe('x.com');
    expect(siteKey('www.threads.net')).toBe('threads.com');
    expect(siteKey('www.google.nl')).toBe('google.com');
    expect(siteKey('old.reddit.com')).toBe('old.reddit.com');
  });
});

describe('decideTier0 categories', () => {
  const sponsored = { kind: 'label' as const, category: 'sponsored' as const, detail: 'x' };
  const suggested = { kind: 'label' as const, category: 'suggested' as const, detail: 'x' };
  const all = { sponsored: true, suggested: true, custom: true };
  const none = { sponsored: false, suggested: false, custom: false };
  it('hides a marker only when its category is on', () => {
    expect(decideTier0({ override: undefined, marker: suggested, categories: all })).toMatchObject({ action: 'hide', category: 'suggested' });
    expect(decideTier0({ override: undefined, marker: suggested, categories: { ...all, suggested: false } }).action).toBe('unknown');
    expect(decideTier0({ override: undefined, marker: sponsored, categories: none }).action).toBe('unknown');
  });
  it('custom hides only when custom is on; a manual hide ignores categories', () => {
    expect(decideTier0({ override: undefined, marker: null, custom: 'word', categories: all })).toMatchObject({ category: 'custom' });
    expect(decideTier0({ override: undefined, marker: null, custom: 'word', categories: none }).action).toBe('unknown');
    expect(decideTier0({ override: 'hide', marker: null, categories: none })).toMatchObject({ action: 'hide', category: 'manual' });
  });
  it('"not-ad" beats everything', () =>
    expect(decideTier0({ override: 'not-ad', marker: sponsored, custom: 'word', categories: all }).action).toBe('show'));
});

describe('detectMarker extras', () => {
  const base = 'https://example.com/';
  const make = (over: Partial<Adapter>): Adapter => AdapterSchema.parse({ id: 't', hosts: ['example.com'], unitSelector: 'article', ...over });
  it('resolves aria-labelledby to a clean "Sponsored"', () => {
    document.body.innerHTML = '<span id="l1">Sponsored</span><article><a aria-labelledby="l1"><span>S</span><span>p</span></a></article>';
    expect(detectMarker(document.querySelector('article')!, make({}), base)).toMatchObject({ kind: 'aria', category: 'sponsored' });
  });
  it('ignores label nodes inside the ignore selector (author links)', () => {
    const a = make({ labelSelectors: ['span'], labelIgnoreSelector: 'a' });
    document.body.innerHTML = '<article><a href="/ad"><span>Ad</span></a><span>hello</span></article>';
    expect(detectMarker(document.querySelector('article')!, a, base)).toBeNull();
    document.body.innerHTML = '<article><a href="/x"><span>x</span></a><span>Ad</span></article>';
    expect(detectMarker(document.querySelector('article')!, a, base)).toMatchObject({ kind: 'label' });
  });
  it('reports suggested only when asked, and sponsored wins', () => {
    const a = make({ labelSelectors: ['span'], suggested: { selectors: [], words: ['Suggested for you'], rules: [] } });
    document.body.innerHTML = '<article><span>Suggested for you</span></article>';
    const u = document.querySelector('article')!;
    expect(detectMarker(u, a, base)).toBeNull();
    expect(detectMarker(u, a, base, { suggested: true })).toMatchObject({ category: 'suggested' });
    document.body.innerHTML = '<article><span>Suggested for you</span><span>Sponsored</span></article>';
    expect(detectMarker(document.querySelector('article')!, a, base, { suggested: true })).toMatchObject({ category: 'sponsored' });
  });
});

describe('scanner: blocks, custom rules, context menu', () => {
  function setup(host: string, body: string, over: Partial<SiteContext> = {}) {
    document.body.innerHTML = body;
    const persisted: Array<[string, string | null]> = [];
    const scanner = new Scanner({
      doc: document,
      hostname: host,
      baseUrl: `https://${host}/`,
      adapter: adapterFor(host),
      context: defaultContext(siteKey(host), over),
      persistOverride: (fp, action) => persisted.push([fp, action]),
      schedule: (fn) => fn(),
    });
    scanner.scanNow();
    return { scanner, persisted };
  }
  const hidden = (sel: string) => document.querySelector(sel)!.classList.contains(HIDDEN_CLASS);
  const xPage =
    '<div data-testid="cellInnerDiv"><div id="t1"><article data-testid="tweet"><span>Plain tweet text</span></article></div></div>' +
    '<aside id="wtf" aria-label="Who to follow"><span>Who to follow</span></aside>' +
    '<div id="promo-box"><span>Some module</span></div>';

  it('adapter blocks hide whole modules only when their category is on', () => {
    setup('x.com', xPage);
    expect(hidden('#wtf')).toBe(false);
    setup('x.com', xPage, { categories: { sponsored: true, suggested: true, custom: true } });
    expect(hidden('#wtf')).toBe(true);
    expect(hidden('#t1')).toBe(false);
  });
  const fbRail =
    '<div role="complementary"><div id="rail">' +
    '<div id="ads"><div><h3><span>Sponsored</span></h3></div><div><a aria-label="Advertiser" href="https://l.facebook.com/l.php?u=x">Acme</a></div></div>' +
    '<div id="contacts"><h3>Contacts</h3><a href="/someone">Someone</a></div>' +
    '</div></div>';
  it('an innermost block hides the module, not the ancestors its :has() rule also matches', () => {
    setup('www.facebook.com', fbRail);
    expect(hidden('#ads')).toBe(true);
    expect(hidden('#rail')).toBe(false);
    expect(hidden('#contacts')).toBe(false);
  });
  it('negative control: the same rule without innermost takes the whole rail', () => {
    const adapter = adapterFor('www.facebook.com')!;
    const plain = { ...adapter, blocks: adapter.blocks.map((b) => ({ ...b, innermost: false })) };
    document.body.innerHTML = fbRail;
    new Scanner({
      doc: document,
      hostname: 'www.facebook.com',
      baseUrl: 'https://www.facebook.com/',
      adapter: plain,
      context: defaultContext(siteKey('www.facebook.com')),
      persistOverride: () => {},
      schedule: (fn) => fn(),
    }).scanNow();
    expect(hidden('#rail')).toBe(true);
  });
  it('element rules hide as custom; an invalid rule is skipped, not fatal', () => {
    setup('x.com', xPage, { customSelectors: ['[[bad', '#promo-box'] });
    expect(hidden('#promo-box')).toBe(true);
    expect(document.querySelector('#promo-box')!.previousElementSibling?.getAttribute('data-sifter-placeholder')).toBe('custom');
    setup('x.com', xPage, { customSelectors: ['#promo-box'], categories: { sponsored: true, suggested: false, custom: false } });
    expect(hidden('#promo-box')).toBe(false);
  });
  it('muted words hide the post as custom', () => {
    setup('x.com', xPage, { mutedWords: ['plain'] });
    expect(hidden('#t1')).toBe(true);
  });
  it('hideContaining hides the enclosing unit, persists it, and survives a re-decide', () => {
    const { scanner, persisted } = setup('x.com', xPage);
    expect(scanner.hideContaining(document.querySelector('#t1 span'))).toBe(true);
    expect(hidden('#t1')).toBe(true);
    expect(persisted).toHaveLength(1);
    const [fp, action] = persisted[0]!;
    expect(action).toBe('hide');
    scanner.applyContext(defaultContext('x.com', { overrides: { [fp]: 'hide' } }));
    expect(hidden('#t1')).toBe(true);
    expect(scanner.hideContaining(document.body)).toBe(false);
  });
});

// Regressions found by the v1 audit: each failed before its fix.
describe('scanner: audit regressions', () => {
  function setup(host: string, body: string, over: Partial<SiteContext> = {}, schedule: (fn: () => void, ms: number) => unknown = (fn) => fn()) {
    document.body.innerHTML = body;
    const persisted: Array<[string, string | null]> = [];
    const context = defaultContext(siteKey(host), over);
    const scanner = new Scanner({
      doc: document,
      hostname: host,
      baseUrl: `https://${host}/`,
      adapter: adapterFor(host),
      context,
      persistOverride: (fp, action) => persisted.push([fp, action]),
      schedule,
    });
    scanner.scanNow();
    return { scanner, context, persisted };
  }
  const hidden = (id: string) => document.getElementById(id)!.classList.contains(HIDDEN_CLASS);
  const card = (id: string, body: string) =>
    `<div role="listitem" componentkey="update-card-focus-${id}" id="${id}"><p componentkey="h"><span>Acme</span><span>Promoted</span></p><div>${body}</div></div>`;

  it('turning a block category off shows the module again', () => {
    const html = '<div data-testid="cellInnerDiv"><div id="t1">An organic tweet</div></div><aside id="wtf" aria-label="Who to follow"><div>Follow</div></aside>';
    const { scanner, context } = setup('x.com', html, { categories: { sponsored: true, suggested: true, custom: true } });
    expect(hidden('wtf')).toBe(true);
    scanner.applyContext({ ...context, categories: { ...context.categories, suggested: false } });
    expect(hidden('wtf')).toBe(false);
    expect(scanner.state().counts).toEqual({});
  });

  it('removing an element rule shows its element again', () => {
    const { scanner, context } = setup('www.linkedin.com', '<div id="promo" class="promo">module</div>', { customSelectors: ['.promo'] });
    expect(hidden('promo')).toBe(true);
    scanner.applyContext({ ...context, customSelectors: [] });
    expect(hidden('promo')).toBe(false);
  });

  it('switching the site off while slices are queued hides nothing', () => {
    const q: Array<() => void> = [];
    const { scanner, context } = setup('www.linkedin.com', card('c0', 'a') + card('c1', 'b'), {}, (fn) => q.push(fn));
    // Positive control: the cards really are queued to be hidden.
    expect(scanner.state().perf.pending).toBe(2);
    scanner.applyContext({ ...context, enabled: false });
    while (q.length) q.shift()!();
    expect(['c0', 'c1'].filter(hidden)).toEqual([]);
  });

  it('settled() resolves once queued slices are done', async () => {
    const q: Array<() => void> = [];
    const { scanner } = setup('www.linkedin.com', card('c0', 'a'), {}, (fn) => q.push(fn));
    let done = false;
    void scanner.settled().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    while (q.length) q.shift()!();
    await Promise.resolve();
    expect(done).toBe(true);
    expect(hidden('c0')).toBe(true);
  });

  it('"Not an ad" on one copy of a post shows its duplicates too', () => {
    setup('www.linkedin.com', card('d1', 'same body') + card('d2', 'same body'));
    const host = document.getElementById('d1')!.previousElementSibling!;
    (host.shadowRoot!.querySelector('[data-act="not-ad"]') as HTMLElement).click();
    expect(hidden('d1')).toBe(false);
    expect(hidden('d2')).toBe(false);
  });

  it('"Show" takes the post out of the counts', () => {
    const { scanner } = setup('www.linkedin.com', card('s1', 'one') + card('s2', 'two'));
    expect(scanner.state().counts).toEqual({ sponsored: 2 });
    scanner.showAll();
    expect(scanner.state().counts).toEqual({});
  });

  it('twitter.com and x.com share fingerprints, so an override follows the site', () => {
    const html = '<div data-testid="cellInnerDiv"><div id="t1"><article data-testid="tweet"><span>Same tweet</span></article></div></div>';
    const a = setup('twitter.com', html);
    a.scanner.hideContaining(document.querySelector('#t1 span'));
    const [fp] = a.persisted[0]!;
    setup('x.com', html, { overrides: { [fp]: 'hide' } });
    expect(hidden('t1')).toBe(true);
  });

  it('Threads: an organic post that links to the Ad Library or says "Ads" is not hidden', () => {
    setup('www.threads.com', '<div data-pressable-container id="p"><a href="/@journo">journo</a><span>Look at this spend</span><a href="https://www.facebook.com/ads/library/?id=1">facebook.com/ads/library</a></div>');
    expect(hidden('p')).toBe(false);
    setup('www.threads.com', '<div data-pressable-container id="p"><a href="/@me">me</a><span>Ads</span><span>why so many lately</span></div>');
    expect(hidden('p')).toBe(false);
  });
});

describe('element rules: aliases and unclosed selectors', () => {
  it('rules for an alias host apply on the site it folds into', () => {
    const { rules } = parseRules('twitter.com##.a\nwww.google.nl##.b\nthreads.net##.c', () => true);
    expect(selectorsFor(rules, siteKey('twitter.com'))).toEqual(['.a']);
    expect(selectorsFor(rules, siteKey('www.google.nl'))).toEqual(['.b']);
    expect(selectorsFor(rules, siteKey('www.threads.net'))).toEqual(['.c']);
  });
  it('rejects a selector that would swallow the rules joined after it', () => {
    const { rules, errors } = parseRules('##div:has(.x\n##[a="b\n##.ok /* c\n##a[href="(x"]\n##.fine', () => true);
    expect(errors.map((e) => e.line)).toEqual([1, 2, 3]);
    expect(rules.map((r) => r.selector)).toEqual(['a[href="(x"]', '.fine']);
  });
});
