import { describe, expect, it } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import type { Adapter } from '../../src/adapters/schema';
import { buildPayload, detectMarker, renderedText, renderedWithin } from '../../src/extract';

const linkedin = adapterFor('www.linkedin.com') as Adapter;
const google = adapterFor('www.google.com') as Adapter;

function unit(markup: string): Element {
  document.head.innerHTML = '<style>.vh { display: none } .inv { visibility: hidden }</style>';
  document.body.innerHTML = markup;
  return document.body.firstElementChild as Element;
}

const post = (header: string, body = '<p componentkey="b"><span>Body text of the post.</span></p>') =>
  `<div role="listitem" componentkey="update-card-focus1"><div><p componentkey="h1"><span>Some Company</span></p><p componentkey="h2"><span>${header}</span></p></div><div>${body}</div></div>`;

describe('renderedWithin', () => {
  it('sees display:none on the node itself (innerText does not)', () => {
    const u = unit('<div><span class="vh">Promoted</span></div>');
    const span = u.querySelector('span') as HTMLElement;
    expect(span.innerText).toBe('Promoted'); // the spec trap this guards against
    expect(renderedWithin(span, u)).toBe(false);
  });
  it('ignores display:none on the unit itself, which is our own hide', () => {
    const u = unit('<div style="display:none"><span>Promoted</span></div>');
    expect(renderedWithin(u.querySelector('span') as Element, u)).toBe(true);
  });
  it('sees visibility:hidden', () => {
    const u = unit('<div><span class="inv">Promoted</span></div>');
    expect(renderedWithin(u.querySelector('span') as Element, u)).toBe(false);
  });
});

describe('renderedText', () => {
  // innerText forces a full-page layout; the whole point of renderedText is to avoid it.
  const noInnerText = (el: Element) =>
    Object.defineProperty(el, 'innerText', { get: () => { throw new Error('innerText read'); } });

  it('joins a word split around a hidden decoy, without reading innerText', () => {
    const u = unit('<p>Pro<span class="vh">zq</span>moted</p>');
    u.querySelectorAll('*').forEach(noInnerText);
    noInnerText(u);
    expect(renderedText(u)).toBe('Promoted');
  });
  it('drops visibility:hidden text but keeps a visible child of a hidden parent', () => {
    const u = unit('<p><span class="inv">zq<span style="visibility:visible">Ad</span></span></p>');
    expect(renderedText(u)).toBe('Ad');
  });
  it('breaks lines at block boxes and <br>, not at inline ones', () => {
    const u = unit('<div><span>Sofia</span> <span>Lind</span><div>Promoted</div>Follow<br>now</div>');
    expect(renderedText(u).split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['Sofia Lind', 'Promoted', 'Follow', 'now']);
  });
});

describe('detectMarker on LinkedIn', () => {
  it('hits a header label', () => expect(detectMarker(unit(post('Promoted')), linkedin, 'https://www.linkedin.com/')?.kind).toBe('label'));
  it('hits a label split around a hidden decoy', () =>
    expect(detectMarker(unit(post('Pro<span class="vh">zq</span>moted')), linkedin, 'https://www.linkedin.com/')).not.toBeNull());
  it('misses a hidden label', () =>
    expect(detectMarker(unit(post('<span class="vh">Promoted</span>')), linkedin, 'https://www.linkedin.com/')).toBeNull());
  it('misses the word inside a sentence', () =>
    expect(detectMarker(unit(post('Promoted to CTO this week')), linkedin, 'https://www.linkedin.com/')).toBeNull());

  const deepAd = post(
    'Founder · 2h',
    '<p componentkey="b1"><span>Q4 was:</span></p><p componentkey="b2"><span>Ad</span></p>',
  );
  it('ignores an "Ad" body line past labelNodeLimit', () =>
    expect(detectMarker(unit(deepAd), linkedin, 'https://www.linkedin.com/')).toBeNull());
  it('negative control: without the limit the same post would hide', () =>
    expect(detectMarker(unit(deepAd), { ...linkedin, labelNodeLimit: undefined }, 'https://www.linkedin.com/')).not.toBeNull());
});

describe('suggested on LinkedIn: social lines and Follow/Connect', () => {
  const base = 'https://www.linkedin.com/';
  const on = { suggested: true };
  const EMPTY = '<button aria-label="menu"></button><button aria-label="hide"></button>';
  const social = (verb: string, rest = '') =>
    `<div role="listitem" componentkey="update-card-focus1"><p componentkey="s"><span><a href="/in/x"><strong>Ella Norr</strong></a><span> </span>${verb}</span></p>${EMPTY}<p componentkey="n"><span>Timo Aalto</span></p>${rest}<p componentkey="b"><span>Body.</span></p></div>`;
  const plain = (afterName: string, body: string) =>
    `<div role="listitem" componentkey="update-card-focus1"><p componentkey="n"><span>Timo Aalto</span></p>${EMPTY}<p componentkey="t"><span>Designer · 2h</span></p>${afterName}<p componentkey="b"><span>${body}</span></p></div>`;

  it('hides "<Name> likes this"', () => expect(detectMarker(unit(social('likes this')), linkedin, base, on)?.category).toBe('suggested'));
  it('hides the other reactions and a Dutch one', () => {
    for (const v of ['celebrates this', 'finds this insightful', 'commented on this', 'vindt dit leuk']) {
      expect(detectMarker(unit(social(v)), linkedin, base, on), v).not.toBeNull();
    }
  });
  it('keeps "<Name> reposted this"', () => expect(detectMarker(unit(social('reposted this')), linkedin, base, on)).toBeNull());
  it('needs a name before the ending: a bare "likes this" does not count', () =>
    expect(detectMarker(unit(plain('', 'x').replace('Timo Aalto', 'likes this')), linkedin, base, on)).toBeNull());
  it('keeps a body line ending "likes this": endings read only the top line', () =>
    expect(detectMarker(unit(plain('', 'The dog likes this')), linkedin, base, on)).toBeNull());
  it('negative control: the same body line as the top line would hide', () =>
    expect(detectMarker(unit(plain('', 'x').replace('Timo Aalto', 'The dog likes this')), linkedin, base, on)).not.toBeNull());
  it('hides a Follow or Connect button in the header', () => {
    expect(detectMarker(unit(plain('<button><span>Follow</span></button>', 'Hi.')), linkedin, base, on)).not.toBeNull();
    expect(detectMarker(unit(plain('<button><span>Connect</span></button>', 'Hi.')), linkedin, base, on)).not.toBeNull();
  });
  it('keeps a reshare whose inner author has a Follow button past the header', () =>
    expect(detectMarker(unit(plain('<p componentkey="i"><span>Rune Dahl</span></p><button><span>Follow</span></button>', 'Hi.')), linkedin, base, on)).toBeNull());
  it('keeps a long body with a "Connect" line inside the header window', () =>
    expect(detectMarker(unit(plain('', `${'Long post. '.repeat(30)}<br>Connect`)), linkedin, base, on)).toBeNull());
  it('negative control: the same line in a short body would hide', () =>
    expect(detectMarker(unit(plain('', 'Short post.<br>Connect')), linkedin, base, on)).not.toBeNull());
  it('does nothing with suggested off', () => expect(detectMarker(unit(social('likes this')), linkedin, base)).toBeNull());
});

describe('detectMarker, structural and link markers', () => {
  it('hits a Google text ad structurally', () =>
    expect(detectMarker(unit('<div data-text-ad="1"><a href="https://x.example/">X</a></div>'), google, 'https://www.google.com/')?.kind).toBe(
      'structural',
    ));
  it('hits an ad-click link on a generic site', () =>
    expect(detectMarker(unit('<div><a href="https://www.googleadservices.com/pagead/aclk?a=1">Deal</a></div>'), null, 'https://news.example/')?.kind).toBe(
      'ad-link',
    ));
  it('hits an exact aria-label', () =>
    expect(detectMarker(unit('<div><span aria-label="Sponsored"></span>text</div>'), null, 'https://x.example/')?.kind).toBe('aria'));
  it('ignores a non-marker aria-label', () =>
    expect(detectMarker(unit('<div><span aria-label="Why this ad?"></span>text</div>'), null, 'https://x.example/')).toBeNull());
  it('finds a standalone label on a generic site', () =>
    expect(detectMarker(unit('<div><div><small>Sponsored</small></div><p>Buy things.</p></div>'), null, 'https://x.example/')?.kind).toBe('label'));
});

describe('buildPayload (rule 3: only capped unit text leaves)', () => {
  it('caps text, drops query strings and same-host links', () => {
    const u = unit(
      post('Promoted', `<p componentkey="b"><span>${'word '.repeat(400)}</span></p><a href="https://shop.example/p?utm_source=li&id=9">Learn more</a><a href="/in/me">me</a>`),
    );
    const p = buildPayload('u1', u, linkedin, 'www.linkedin.com', 'https://www.linkedin.com/');
    expect(p.text.length).toBeLessThanOrEqual(600);
    expect(p.linkHosts).toEqual(['shop.example']);
    expect(JSON.stringify(p)).not.toContain('utm_source');
    expect(p.hasCta).toBe(true);
    expect(p.labels).toContain('Promoted');
  });
});
