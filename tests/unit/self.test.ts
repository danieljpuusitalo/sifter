import { afterEach, describe, expect, it } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { defaultContext, type SiteContext } from '../../src/messages';
import { learnSelf, learnsOn, selfIdOf, selfMatch } from '../../src/self';
import { parseSettings, withSelf } from '../../src/storage/settings';

// A LinkedIn post that mentions the viewer is about them (a tag, a reply), and a
// notification opens it: it never hides as suggested. Every case that keeps a post
// has a control beside it that hides, so a rule that stopped matching fails here.
// Ids are documented fakes, never a real profile.

const ON = { sponsored: true, suggested: true, custom: true };
const ME = 'test-viewer';
const adapter = adapterFor('www.linkedin.com')!;
const self = adapter.self!;

const mention = (href: string) => ` <a href="${href}">Test Viewer</a>`;
const card = (id: string, top: string, body = '', button = '') =>
  `<div id="${id}" role="listitem" componentkey="update-card-focus-${id}"><p componentkey="s"><span>${top}</span></p><button></button><button></button><p componentkey="n"><span>Timo Aalto</span></p>${button}<p componentkey="b"><span>Body.${body}</span></p></div>`;
const follow = '<button><span>Follow</span></button>';
const wrap = (inner: string) => `<main><div data-testid="mainFeed" role="list">${inner}</div></main>`;
const hidden = (id: string) => document.getElementById(id)!.classList.contains(HIDDEN_CLASS);
const ctx = (over: Partial<SiteContext> = {}) => defaultContext('linkedin.com', { categories: ON, self: ME, ...over });

let scanner: Scanner | undefined;
afterEach(() => {
  scanner?.stop();
  scanner = undefined;
});

/** decide(): every scheduled pass runs at once. */
function decide(html: string, context = ctx()) {
  document.body.innerHTML = wrap(html);
  scanner = new Scanner({
    doc: document,
    hostname: 'www.linkedin.com',
    baseUrl: 'https://www.linkedin.com/feed/',
    adapter,
    context,
    persistOverride: () => undefined,
    schedule: (fn) => fn(),
  });
  scanner.scanNow();
  return scanner;
}

/** The pre-paint lane alone: the debounced pass is held, so whatever hides before it ran was the lane. */
async function lane(html: string, context = ctx()) {
  document.body.innerHTML = wrap('');
  const queue: Array<() => void> = [];
  scanner = new Scanner({
    doc: document,
    hostname: 'www.linkedin.com',
    baseUrl: 'https://www.linkedin.com/feed/',
    adapter,
    context,
    persistOverride: () => undefined,
    schedule: (fn) => void queue.push(fn),
    frame: () => undefined,
    now: () => 0,
  });
  scanner.start();
  for (let i = 0; queue.length && i < 1000; i++) queue.shift()!();
  document.querySelector('[data-testid="mainFeed"]')!.insertAdjacentHTML('beforeend', html);
  for (let i = 0; i < 3; i++) await Promise.resolve();
  return scanner;
}

const POSTS =
  card('plain', 'Ella Norr likes this') +
  card('tagged', 'Ella Norr celebrates this', mention(`https://www.linkedin.com/in/${ME}/`)) +
  card('taggedRelative', 'Ella Norr likes this', mention(`/in/${ME}?miniProfileUrn=x`)) +
  card('other', 'Ella Norr likes this', mention('https://www.linkedin.com/in/someone-else/')) +
  card('longer', 'Ella Norr likes this', mention(`https://www.linkedin.com/in/${ME}-2/`)) +
  card('strangerTagged', 'Rune Dahl', mention(`/in/${ME}/`), follow) +
  card('ad', 'Promoted', mention(`/in/${ME}/`));

describe('LinkedIn: a post that mentions the viewer stays visible', () => {
  it('decide(): a mention keeps it; no mention, someone else, or a longer id still hides', () => {
    decide(POSTS);
    expect(hidden('plain'), 'positive control').toBe(true);
    expect(hidden('tagged')).toBe(false);
    expect(hidden('taggedRelative')).toBe(false);
    expect(hidden('strangerTagged'), 'the follow rule is skipped too').toBe(false);
    expect(hidden('other'), 'someone else mentioned').toBe(true);
    expect(hidden('longer'), '/in/test-viewer-2/ is not the viewer').toBe(true);
  });

  it('a sponsored post that mentions the viewer still hides', () => {
    decide(POSTS);
    expect(hidden('ad')).toBe(true);
  });

  it('the pre-paint lane agrees with decide()', async () => {
    const s = await lane(POSTS);
    expect(hidden('plain'), 'positive control: the lane hides suggested posts').toBe(true);
    expect(hidden('tagged')).toBe(false);
    expect(hidden('taggedRelative')).toBe(false);
    expect(hidden('strangerTagged')).toBe(false);
    expect(hidden('other')).toBe(true);
    expect(hidden('longer')).toBe(true);
    expect(hidden('ad')).toBe(true);
    expect(s.state().perf.laneReleases).toBe(0);
  });

  it('counts the posts it kept', () => {
    expect(decide(POSTS).state().perf.selfKept).toBeGreaterThanOrEqual(3);
    expect(decide(card('plain', 'Ella Norr likes this')).state().perf.selfKept).toBe(0);
  });

  it('with no learned id, a mention changes nothing', () => {
    decide(POSTS, ctx({ self: undefined }));
    expect(hidden('tagged')).toBe(true);
    expect(hidden('strangerTagged')).toBe(true);
  });

  it('a malformed stored id is ignored, never put into a selector', () => {
    expect(selfMatch(self, 'x"] , * [y')).toBeNull();
    decide(POSTS, ctx({ self: 'x"] , * [y' }));
    expect(hidden('tagged')).toBe(true);
  });

  it('a newly learned id applies to posts already on the page', () => {
    const s = decide(POSTS, ctx({ self: undefined }));
    expect(hidden('tagged')).toBe(true);
    s.applyContext(ctx());
    s.scanNow();
    expect(hidden('tagged')).toBe(false);
    expect(hidden('plain')).toBe(true);
  });
});

describe('selfIdOf', () => {
  it('reads the id from absolute and same-site hrefs, ending at / ? #', () => {
    expect(selfIdOf(`https://www.linkedin.com/in/${ME}/`, '/in/')).toBe(ME);
    expect(selfIdOf(`/in/${ME}`, '/in/')).toBe(ME);
    expect(selfIdOf(`/in/${ME}?x=1`, '/in/')).toBe(ME);
    expect(selfIdOf(`/in/${ME}#top`, '/in/')).toBe(ME);
    expect(selfIdOf(`/in/${ME}/recent-activity/`, '/in/')).toBe(ME);
  });
  it('rejects other paths and ids a selector could not hold literally', () => {
    expect(selfIdOf(`/company/${ME}/`, '/in/')).toBeNull();
    expect(selfIdOf('/feed/?x=/in/test-viewer/', '/in/')).toBeNull();
    expect(selfIdOf('/in/', '/in/')).toBeNull();
    expect(selfIdOf('/in/a"b/', '/in/')).toBeNull();
  });
});

describe('learnSelf', () => {
  const page = (aside: string, rest = '') => {
    document.body.innerHTML = `<aside aria-label="Sidebar">${aside}</aside><main>${rest}</main><aside aria-label="Aside"><a href="/in/someone-else/">x</a><a href="/in/someone-else/">x</a></aside>`;
    return document;
  };
  const a = (id: string) => `<a href="https://www.linkedin.com/in/${id}/">x</a>`;

  it('learns an id that two links in the first aside agree on', () => {
    expect(learnSelf(page(a(ME) + a(ME) + a(ME)), self)).toBe(ME);
  });
  it('one link is not enough', () => {
    expect(learnSelf(page(a(ME)), self)).toBeNull();
  });
  it('a mixed set learns nothing', () => {
    expect(learnSelf(page(a(ME) + a(ME) + a('someone-else')), self)).toBeNull();
  });
  it('reads only the first aside, never the right rail or the feed', () => {
    expect(learnSelf(page('', a(ME) + a(ME)), self)).toBeNull();
  });
  it('learns on the feed only, never on a profile or a single post', () => {
    expect(learnsOn(adapter, '/feed/')).toBe(true);
    expect(learnsOn(adapter, '/')).toBe(true);
    expect(learnsOn(adapter, '/in/someone-else/')).toBe(false);
    expect(learnsOn(adapter, '/feed/update/urn:li:activity:1/')).toBe(false);
    expect(learnsOn({}, '/anything')).toBe(true);
  });
  it('no aside, or an invalid selector, learns nothing', () => {
    document.body.innerHTML = a(ME) + a(ME);
    expect(learnSelf(document, self)).toBeNull();
    expect(learnSelf(page(a(ME) + a(ME)), { ...self, source: 'aside[' })).toBeNull();
  });
});

describe('settings: the learned id', () => {
  it('withSelf sets and forgets it, keeping the rest of the site', () => {
    const base = parseSettings({ sites: { 'linkedin.com': { enabled: false } } });
    const set = withSelf(base, 'linkedin.com', ME);
    expect(set.sites['linkedin.com']).toEqual({ ...base.sites['linkedin.com'], self: ME });
    const gone = withSelf(set, 'linkedin.com', null);
    expect(gone.sites['linkedin.com']?.self).toBeUndefined();
    expect(gone.sites['linkedin.com']?.enabled).toBe(false);
  });
  it('a malformed stored id costs that field, not the site', () => {
    const s = parseSettings({ sites: { 'linkedin.com': { enabled: false, self: 'a"]{}' } } });
    expect(s.sites['linkedin.com']?.self).toBeUndefined();
    expect(s.sites['linkedin.com']?.enabled).toBe(false);
    expect(parseSettings({ sites: { 'linkedin.com': { self: ME } } }).sites['linkedin.com']?.self).toBe(ME);
  });
});
