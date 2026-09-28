import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { ADAPTERS, adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { defaultContext } from '../../src/messages';
import { siteKey } from '../../src/storage/settings';

// "Suggested" is a feed concept: a Follow button on a post the feed pushed at you
// is a recommendation, the same button on a company page you opened is not. On
// LinkedIn the suggested rules apply on the home feed only; sponsored everywhere.

const HOST = 'www.linkedin.com';
const ON = { sponsored: true, suggested: true, custom: true };

let doc: Document;

/** The whole fixture, head styles included, the way the eval loads it (a body-only copy drops a decoy style). */
function load(): void {
  const win = new Window({
    url: `https://${HOST}/`,
    settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableIframePageLoading: true },
  });
  doc = win.document as unknown as Document;
  doc.write(readFileSync('fixtures/public/linkedin-feed.html', 'utf8'));
}

function scan(path: () => string): Scanner {
  load();
  const scanner = new Scanner({
    doc,
    hostname: HOST,
    baseUrl: `https://${HOST}/`,
    path,
    adapter: adapterFor(HOST),
    context: defaultContext(siteKey(HOST), { categories: ON }),
    persistOverride: () => undefined,
    schedule: (fn) => fn(),
  });
  scanner.start();
  return scanner;
}

const hiddenGold = (gold: string) =>
  [...doc.querySelectorAll(`[data-gold="${gold}"]`)].filter((u) => u.classList.contains(HIDDEN_CLASS)).length;
const total = (gold: string) => doc.querySelectorAll(`[data-gold="${gold}"]`).length;

describe('LinkedIn: suggested applies on the home feed only', () => {
  it('positive control: on /feed/ every suggested and sponsored unit is hidden', () => {
    const s = scan(() => '/feed/');
    expect(total('suggested')).toBeGreaterThan(0);
    expect(hiddenGold('suggested')).toBe(total('suggested'));
    expect(hiddenGold('sponsored')).toBe(total('sponsored'));
    expect(hiddenGold('none')).toBe(0);
    s.stop();
  });

  it('the bare root is the feed too', () => {
    const s = scan(() => '/');
    expect(hiddenGold('suggested')).toBe(total('suggested'));
    s.stop();
  });

  for (const path of ['/company/acme/', '/company/acme/posts/', '/feed/update/urn:li:activity:7000000000000000000/', '/in/someone/recent-activity/all/', '/search/results/content/']) {
    it(`on ${path} no suggested unit is hidden, and sponsored still is`, () => {
      const s = scan(() => path);
      expect(hiddenGold('suggested')).toBe(0);
      expect(hiddenGold('sponsored')).toBe(total('sponsored'));
      s.stop();
    });
  }

  it('an in-app navigation off the feed releases suggested hides, and back on re-hides them', async () => {
    let path = '/feed/';
    const s = scan(() => path);
    expect(hiddenGold('suggested')).toBe(total('suggested'));

    path = '/company/acme/posts/';
    doc.body.appendChild(doc.createElement('div')); // the SPA re-renders
    await new Promise((r) => setTimeout(r, 0));
    expect(hiddenGold('suggested')).toBe(0);
    expect(hiddenGold('sponsored')).toBe(total('sponsored'));

    path = '/feed/';
    doc.body.appendChild(doc.createElement('div'));
    await new Promise((r) => setTimeout(r, 0));
    expect(hiddenGold('suggested')).toBe(total('suggested'));
    s.stop();
  });
});

describe('adapter suggested.paths', () => {
  it('every pattern compiles', () => {
    for (const a of ADAPTERS) {
      for (const p of a.suggested?.paths ?? []) expect(() => new RegExp(p), `${a.id}: ${p}`).not.toThrow();
    }
  });

  it('LinkedIn: the feed matches, a single post and a company page do not', () => {
    const res = (adapterFor(HOST)?.suggested?.paths ?? []).map((p) => new RegExp(p));
    const onFeed = (path: string) => res.some((re) => re.test(path));
    expect(res.length).toBeGreaterThan(0);
    for (const p of ['/', '/feed', '/feed/']) expect(onFeed(p), p).toBe(true);
    for (const p of ['/feed/update/urn:li:activity:1/', '/company/acme/', '/in/someone/', '/posts/someone_activity-1']) {
      expect(onFeed(p), p).toBe(false);
    }
  });
});
