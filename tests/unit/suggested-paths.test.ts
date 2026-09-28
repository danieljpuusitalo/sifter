import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { ADAPTERS, adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { defaultContext } from '../../src/messages';
import { siteKey } from '../../src/storage/settings';

// "Suggested" is a feed concept: a Follow button on a post the feed pushed at you
// is a recommendation, the same button on a company page you opened is not. Each
// site's suggested rules and suggested blocks apply on its feed only
// (`suggestedPaths`); sponsored detection runs on every page.

type Site = {
  fixture: string;
  host: string;
  /** Paths that are the feed. The first is the positive control. */
  feed: string[];
  /** Pages the user opened on purpose: nothing suggested may be hidden there. */
  off: string[];
};

const SITES: Site[] = [
  {
    fixture: 'linkedin-feed',
    host: 'www.linkedin.com',
    feed: ['/feed/', '/', '/feed'],
    off: ['/company/acme/', '/company/acme/posts/', '/feed/update/urn:li:activity:7000000000000000000/', '/in/someone/recent-activity/all/', '/search/results/content/', '/posts/someone_activity-1'],
  },
  {
    fixture: 'facebook-feed',
    host: 'www.facebook.com',
    feed: ['/', '/home.php', '/groups/feed/', '/groups/feed'],
    off: ['/acmepage', '/acmepage/posts/1234', '/profile.php', '/groups/123456/', '/groups/123456/posts/789/', '/watch/', '/reel/123/', '/homeXphp'],
  },
  {
    fixture: 'instagram-feed',
    host: 'www.instagram.com',
    feed: ['/'],
    off: ['/someone/', '/p/Cabc123/', '/explore/', '/reels/', '/explore/people/'],
  },
  {
    fixture: 'x-home',
    host: 'x.com',
    feed: ['/home'],
    off: ['/someone', '/someone/status/123', '/explore', '/search', '/home/extra'],
  },
];

const ON = { sponsored: true, suggested: true, custom: true };

/** The whole fixture, head styles included, the way the eval loads it (a body-only copy drops a decoy style). */
function load(site: Site): Document {
  const win = new Window({
    url: `https://${site.host}/`,
    settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableIframePageLoading: true },
  });
  const doc = win.document as unknown as Document;
  doc.write(readFileSync(`fixtures/public/${site.fixture}.html`, 'utf8'));
  return doc;
}

function scan(site: Site, path: () => string): { doc: Document; scanner: Scanner } {
  const doc = load(site);
  const scanner = new Scanner({
    doc,
    hostname: site.host,
    baseUrl: `https://${site.host}/`,
    path,
    adapter: adapterFor(site.host),
    context: defaultContext(siteKey(site.host), { categories: ON }),
    persistOverride: () => undefined,
    schedule: (fn) => fn(),
  });
  scanner.start();
  return { doc, scanner };
}

const hidden = (doc: Document, gold: string) =>
  [...doc.querySelectorAll(`[data-gold="${gold}"]`)].filter(
    (u) => u.classList.contains(HIDDEN_CLASS) || !!u.closest(`.${HIDDEN_CLASS}`) || !!u.querySelector(`.${HIDDEN_CLASS}`),
  ).length;
const total = (doc: Document, gold: string) => doc.querySelectorAll(`[data-gold="${gold}"]`).length;

for (const site of SITES) {
  describe(`${site.fixture}: suggested applies on the feed only`, () => {
    it(`positive control: on ${site.feed[0]} every suggested and sponsored unit is hidden`, () => {
      const { doc, scanner } = scan(site, () => site.feed[0]!);
      expect(total(doc, 'suggested')).toBeGreaterThan(0);
      expect(hidden(doc, 'suggested')).toBe(total(doc, 'suggested'));
      expect(hidden(doc, 'sponsored')).toBe(total(doc, 'sponsored'));
      expect(hidden(doc, 'none')).toBe(0);
      scanner.stop();
    });

    for (const path of site.off) {
      it(`on ${path} no suggested unit is hidden, and sponsored still is`, () => {
        const { doc, scanner } = scan(site, () => path);
        expect(hidden(doc, 'suggested')).toBe(0);
        expect(hidden(doc, 'sponsored')).toBe(total(doc, 'sponsored'));
        scanner.stop();
      });
    }

    it('an in-app navigation off the feed releases suggested hides, and back on re-hides them', async () => {
      let path = site.feed[0]!;
      const { doc, scanner } = scan(site, () => path);
      expect(hidden(doc, 'suggested')).toBe(total(doc, 'suggested'));

      path = site.off[0]!;
      doc.body.appendChild(doc.createElement('div')); // the SPA re-renders
      await new Promise((r) => setTimeout(r, 0));
      expect(hidden(doc, 'suggested')).toBe(0);
      expect(hidden(doc, 'sponsored')).toBe(total(doc, 'sponsored'));

      path = site.feed[0]!;
      doc.body.appendChild(doc.createElement('div'));
      await new Promise((r) => setTimeout(r, 0));
      expect(hidden(doc, 'suggested')).toBe(total(doc, 'suggested'));
      scanner.stop();
    });

    it('suggestedPaths match every feed path and no off-feed path', () => {
      const res = (adapterFor(site.host)?.suggestedPaths ?? []).map((p) => new RegExp(p));
      const onFeed = (path: string) => res.some((re) => re.test(path));
      expect(res.length).toBeGreaterThan(0);
      for (const p of site.feed) expect(onFeed(p), p).toBe(true);
      for (const p of site.off) expect(onFeed(p), p).toBe(false);
    });
  });
}

describe('adapter suggestedPaths', () => {
  it('every pattern compiles', () => {
    for (const a of ADAPTERS) {
      for (const p of a.suggestedPaths ?? []) expect(() => new RegExp(p), `${a.id}: ${p}`).not.toThrow();
    }
  });

  it('every adapter with a suggested rule or block is scoped to its feed', () => {
    for (const a of ADAPTERS) {
      const suggests = !!a.suggested || a.blocks.some((b) => b.category === 'suggested');
      if (suggests) expect(a.suggestedPaths?.length ?? 0, a.id).toBeGreaterThan(0);
    }
  });
});
