import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { experimentalNote, LAUNCH_SITES } from '../../src/sites';

// The tag has to say the same thing everywhere: the popup and options read
// LAUNCH_SITES, the README is prose. Pin both so one cannot drift without the other.
describe('experimental sites', () => {
  it('Facebook is experimental, every other launch site is not', () => {
    expect(experimentalNote('facebook.com')).toMatch(/get through/);
    for (const s of LAUNCH_SITES.filter((s) => s.key !== 'facebook.com')) {
      expect(experimentalNote(s.key), s.key).toBeNull();
    }
    expect(experimentalNote('example.com')).toBeNull();
  });

  it('the README coverage table carries the same tag', () => {
    const readme = readFileSync('README.md', 'utf8');
    const row = readme.split('\n').find((l) => l.startsWith('| Facebook'));
    expect(row).toMatch(/experimental/i);
    for (const s of LAUNCH_SITES.filter((s) => !s.experimental)) {
      const other = readme.split('\n').find((l) => l.startsWith(`| ${s.name}`));
      expect(other, s.name).toBeDefined();
      expect(other).not.toMatch(/experimental/i);
    }
  });
});
