import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { parseSettings } from '../../src/storage/settings';

describe('zod jitless', () => {
  it('is on once settings are loaded, and schemas still parse', () => {
    expect(z.config().jitless).toBe(true);
    expect(parseSettings({}).sites).toBeDefined();
  });
});
