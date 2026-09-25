import { describe, expect, it } from 'vitest';
import { injectTargetMatches, LAUNCH_MATCHES, optInScriptMatches } from '../../src/sites';

// Change A: Chrome never injects content_scripts into tabs that were already
// open at install/update, so background.ts force-injects into every tab that
// matches these patterns. Both the opt-in match list and the combined
// injection-target list are pure so a regression here can't hide behind a
// mocked chrome.tabs/chrome.scripting call.

describe('optInScriptMatches', () => {
  it('is empty with no opt-in hosts', () => {
    expect(optInScriptMatches([], ['https://news.example/*'])).toEqual([]);
  });
  it('only includes hosts whose origin (bare or www) was granted', () => {
    expect(optInScriptMatches(['news.example', 'other.example'], ['https://news.example/*'])).toEqual(['https://news.example/*']);
    expect(optInScriptMatches(['news.example'], ['https://www.news.example/*'])).toEqual(['https://www.news.example/*']);
  });
  it('an "on all sites" grant covers every opt-in host', () => {
    expect(optInScriptMatches(['a.example', 'b.example'], ['https://*/*'])).toEqual([
      'https://a.example/*',
      'https://www.a.example/*',
      'https://b.example/*',
      'https://www.b.example/*',
    ]);
  });
  it('a host with no grant at all contributes nothing', () => {
    expect(optInScriptMatches(['ungranted.example'], [])).toEqual([]);
  });
});

describe('injectTargetMatches', () => {
  it('is the launch matches plus the opt-in matches, launch matches first', () => {
    const optIn = ['https://news.example/*'];
    expect(injectTargetMatches(optIn)).toEqual([...LAUNCH_MATCHES, ...optIn]);
  });
  it('is just the launch matches when there are no opt-in hosts', () => {
    expect(injectTargetMatches([])).toEqual(LAUNCH_MATCHES);
  });
});
