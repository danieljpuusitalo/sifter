import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adapterFor } from '../../src/adapters/index';
import { HIDDEN_CLASS } from '../../src/content/hider';
import { Scanner } from '../../src/content/scanner';
import { defaultContext } from '../../src/messages';

// The Stories bar at the top of the home feed (BRIEF §... Change B, 2026-09-25):
// div[role="region"] aria-label "Stories", outside [role="feed"], containing
// a[href*="/stories/create"]. It is a suggested block gated by its own rule id
// "stories", so it can be switched off independently of the other suggestions.

const ON = { sponsored: true, suggested: true, custom: true };
const STORIES = '[role="region"][aria-label="Stories"]';

function scan(offRules: string[]) {
  const html = readFileSync('fixtures/public/facebook-feed.html', 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>')).replace(/^<body[^>]*>/, '');
  const scanner = new Scanner({
    doc: document,
    hostname: 'www.facebook.com',
    baseUrl: 'https://www.facebook.com/',
    adapter: adapterFor('www.facebook.com'),
    context: defaultContext('facebook.com', { categories: ON, offRules }),
    persistOverride: () => undefined,
    schedule: (fn) => fn(),
  });
  scanner.scanNow();
  return scanner;
}
const hidden = () => document.querySelector(STORIES)!.classList.contains(HIDDEN_CLASS);

describe('Facebook: Stories bar', () => {
  it('is hidden when the suggested category and the "stories" rule are both on', () => {
    scan([]);
    expect(hidden()).toBe(true);
  });
  it('stays visible when "stories" is switched off', () => {
    scan(['stories']);
    expect(hidden()).toBe(false);
  });
});

// Live report H (2026-10-01): Stories also come as a feed unit, its cards inside a
// role=region. An ordinary post links one story from its author's avatar, with no region.
describe('Facebook: Stories in the feed', () => {
  const post = (n: number) => document.querySelector(`[aria-posinset="${n}"]`)!.classList.contains(HIDDEN_CLASS);
  it('is hidden under the "stories" rule', () => {
    scan([]);
    expect(post(13)).toBe(true);
  });
  it('a post whose avatar links to a story stays visible', () => {
    scan([]);
    expect(post(13), 'positive control').toBe(true);
    expect(post(14)).toBe(false);
  });
  it('stays visible when "stories" is switched off', () => {
    scan(['stories']);
    expect(post(13)).toBe(false);
  });
});
