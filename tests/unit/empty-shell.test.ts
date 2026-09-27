import { describe, expect, it } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS, PLACEHOLDER_ATTR } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { hasContent } from '../../src/extract';
import { defaultContext } from '../../src/messages';

// Google serves its ad shells (#tads, #atvcap, #bottomads > #tadsb) on every
// results page and fills them only when it has ads. The shells are structural
// markers themselves, so an empty one used to get a "Hidden" row that Show
// revealed nothing under: three of them on "how tall is the eiffel tower",
// observed live on 2026-09-27. Shape below is that page's, contents stripped.

const HOST = 'www.google.com';
const EMPTY_SHELLS =
  `<div id="tvcap"><div id="atvcap" data-st-cnt="atvcap"><div class="x"></div></div>` +
  `<div id="tads"><div style="display:none"></div><div style="display:none"></div></div></div>` +
  `<div id="rso"><div class="MjjYud" id="org"><h3>Eiffel Tower height</h3><a href="https://example.com/">330 m</a></div></div>` +
  `<div id="bottomads"><div id="tadsb"></div></div>`;

const AD = `<div data-text-ad="1"><a href="https://example.com/aclk"><span>Cheap flights</span></a> Book now from 29 euro</div>`;

function setup(html: string) {
  document.body.innerHTML = html;
  const scanner = new Scanner({
    doc: document,
    hostname: HOST,
    baseUrl: `https://${HOST}/`,
    adapter: adapterFor(HOST),
    context: defaultContext('google.com'),
    persistOverride: () => {},
    schedule: (fn) => fn(),
  });
  scanner.scanNow();
  return scanner;
}

const hidden = () => [...document.querySelectorAll(`.${HIDDEN_CLASS}`)].map((e) => e.id || e.className);
const placeholders = () => document.querySelectorAll(`[${PLACEHOLDER_ATTR}]`).length;
const rescan = (s: Scanner) => s.applyContext(defaultContext('google.com'));

describe('empty ad shells are never hidden', () => {
  it('a page with no ads gets no hide and no placeholder', () => {
    const scanner = setup(EMPTY_SHELLS);
    expect(hidden()).toEqual([]);
    expect(placeholders()).toBe(0);
    expect(scanner.state().perf.emptySkipped, 'positive control: the shells were reached').toBeGreaterThan(0);
  });

  it('positive control: the same shells with ads in them are hidden', () => {
    setup(EMPTY_SHELLS.replace('<div class="x"></div>', AD).replace('<div id="tadsb"></div>', `<div id="tadsb">${AD}</div>`));
    expect(hidden()).toEqual(expect.arrayContaining(['atvcap', 'bottomads']));
    expect(hidden()).not.toContain('org');
  });

  it('a shell that fills in later is hidden then', () => {
    const scanner = setup(EMPTY_SHELLS);
    expect(hidden()).toEqual([]);
    document.querySelector('#tads > div')!.innerHTML = AD;
    rescan(scanner);
    expect(hidden()).toContain('tads');
  });

  it('an image-only fill is hidden too, though it leaves the text signature alone', () => {
    const scanner = setup(EMPTY_SHELLS);
    const img = document.createElement('img');
    img.src = 'https://example.com/creative.png';
    document.querySelector('#atvcap > div')!.append(img);
    rescan(scanner);
    expect(hidden()).toContain('atvcap');
  });

  it('a hidden shell that empties again is released, placeholder and all', () => {
    const scanner = setup(EMPTY_SHELLS.replace('<div id="tadsb"></div>', `<div id="tadsb">${AD}</div>`));
    expect(hidden(), 'positive control').toContain('bottomads');
    document.getElementById('tadsb')!.replaceChildren();
    rescan(scanner);
    expect(hidden()).not.toContain('bottomads');
    expect(placeholders()).toBe(0);
  });
});

describe('hasContent', () => {
  const el = (html: string) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d;
  };
  it('is false for blank text, script and style only', () => {
    expect(hasContent(el('  <div> \n </div><script>var a=1</script><style>.a{}</style>'))).toBe(false);
  });
  it('is true for text, media or a link', () => {
    expect(hasContent(el('<span>x</span>'))).toBe(true);
    expect(hasContent(el('<img src="a.png">'))).toBe(true);
    expect(hasContent(el('<iframe></iframe>'))).toBe(true);
    expect(hasContent(el('<a href="/x"></a>'))).toBe(true);
  });
});
