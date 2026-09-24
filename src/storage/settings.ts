import { z } from 'zod';
import { browser } from 'wxt/browser';
import { MAX_WORDS } from '../rules/filters';
import { HOSTNAME_RE, siteKey } from '../sites';
import type { CategoryToggles } from '../types';

// Everything persists to browser.storage.local (hard rule 11: the service worker
// can be killed at any moment, so no state lives only in memory). Only trusted
// contexts (service worker, popup, options) touch storage; the background locks
// storage.local to TRUSTED_CONTEXTS so content scripts can never read an API key
// (hard rule 4). Content scripts get what they need by message.

export const HideModeSchema = z.enum(['collapse', 'blur', 'hide']);

const CategoryTogglesSchema = z.object({
  sponsored: z.boolean().default(true),
  suggested: z.boolean().default(false),
  custom: z.boolean().default(true),
});

/** Per-site overrides of the global toggles; a missing key follows the global setting. */
export const SiteSettingSchema = z.object({
  enabled: z.boolean().optional(),
  categories: z.object({ sponsored: z.boolean(), suggested: z.boolean(), custom: z.boolean() }).partial().optional(),
  /**
   * The adapter's named suggested rules switched off here ("groups": false). Only
   * false is stored: a rule is on whenever the site's "suggested" is. A bad value
   * costs this field, not the whole sites map.
   */
  rules: z.record(z.string().max(32), z.literal(false)).optional().catch(undefined),
});

/** Caps on what storage (or a backup file) may hold, so a hostile file can't stall every page. */
const MAX_HOSTS = 500;
const MAX_WORD_LEN = 100;
const MAX_RULES_TEXT = 50_000;

export const SettingsSchema = z.object({
  version: z.literal(1).catch(1),
  /** Keyed by site key (hostname without a leading "www."). Missing = default for that site. */
  sites: z.record(z.string(), SiteSettingSchema).catch({}),
  /**
   * Hosts outside the manifest the user switched on from the popup. Each becomes a
   * match pattern, so anything that isn't a plain hostname ("*", a port) is dropped.
   */
  optInHosts: z
    .array(z.string())
    .catch([])
    .transform((hosts) => [...new Set(hosts.map((h) => h.toLowerCase()).filter((h) => HOSTNAME_RE.test(h)))].slice(0, MAX_HOSTS)),
  pausedUntil: z.number().nullable().catch(null),
  hideMode: HideModeSchema.catch('collapse'),
  /** What to block everywhere, like an ad blocker's filter lists. */
  categories: CategoryTogglesSchema.catch({ sponsored: true, suggested: false, custom: true }),
  /** Muted words: a post containing one is hidden as "custom". */
  mutedWords: z
    .array(z.string())
    .catch([])
    .transform((words) => words.filter((w) => w.length <= MAX_WORD_LEN).slice(0, MAX_WORDS)),
  /** Element rules, one "site##selector" per line, kept as typed so the options page can show them back. */
  rulesText: z
    .string()
    .catch('')
    .transform((t) => t.slice(0, MAX_RULES_TEXT)),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const OverridesSchema = z.record(
  z.string(), // site key
  z.record(z.string(), z.enum(['not-ad', 'hide'])), // fingerprint -> action
);
export type Overrides = z.infer<typeof OverridesSchema>;

export { siteKey };

export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

/**
 * Parse stored settings. Every field falls back to its default on its own (the
 * schema's `.catch`), so one bad value, say from a newer version after a
 * downgrade, costs that field and not the user's whole configuration.
 */
export function parseSettings(raw: unknown): Settings {
  const r = SettingsSchema.safeParse(raw && typeof raw === 'object' ? raw : {});
  return r.success ? r.data : defaultSettings();
}

export function parseOverrides(raw: unknown): Overrides {
  const r = OverridesSchema.safeParse(raw ?? {});
  return r.success ? r.data : {};
}

export function isSiteEnabled(settings: Settings, key: string, isLaunchSite: boolean): boolean {
  const s = settings.sites[key];
  if (s?.enabled !== undefined) return s.enabled;
  return isLaunchSite || settings.optInHosts.includes(key);
}

/** The categories in force on one site: the global toggles with that site's overrides on top. */
export function siteCategories(settings: Settings, key: string): CategoryToggles {
  return { ...settings.categories, ...(settings.sites[key]?.categories ?? {}) };
}

/** Suggested rule ids switched off on one site. */
export function siteOffRules(settings: Settings, key: string): string[] {
  return Object.keys(settings.sites[key]?.rules ?? {});
}

export function isPaused(settings: Settings, now: number): boolean {
  return settings.pausedUntil !== null && settings.pausedUntil > now;
}

// ---- browser.storage access (trusted contexts only) ----

const KEYS = { settings: 'settings', overrides: 'overrides' } as const;

/** Serialise read-modify-write cycles so two quick clicks can't lose an update. */
let writeChain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

export async function loadSettings(): Promise<Settings> {
  const got = await browser.storage.local.get(KEYS.settings);
  return parseSettings(got[KEYS.settings]);
}

export async function saveSettings(s: Settings): Promise<void> {
  await browser.storage.local.set({ [KEYS.settings]: SettingsSchema.parse(s) });
}

export function updateSettings(fn: (s: Settings) => Settings): Promise<Settings> {
  return serial(async () => {
    const next = fn(await loadSettings());
    await saveSettings(next);
    return next;
  });
}

export async function loadOverrides(): Promise<Overrides> {
  const got = await browser.storage.local.get(KEYS.overrides);
  return parseOverrides(got[KEYS.overrides]);
}

/** Forget "Not an ad" / "Hide this" choices for one site, or for every site when key is null. */
export function clearOverrides(key: string | null): Promise<void> {
  return serial(async () => {
    const all = await loadOverrides();
    if (key === null) await browser.storage.local.set({ [KEYS.overrides]: {} });
    else {
      delete all[key];
      await browser.storage.local.set({ [KEYS.overrides]: all });
    }
  });
}

export const BackupSchema = z.object({
  app: z.literal('sifter'),
  version: z.literal(1),
  settings: SettingsSchema,
  overrides: OverridesSchema,
});
export type Backup = z.infer<typeof BackupSchema>;

export async function exportBackup(): Promise<Backup> {
  const [settings, overrides] = await Promise.all([loadSettings(), loadOverrides()]);
  return { app: 'sifter', version: 1, settings, overrides };
}

/** Replace settings and overrides from a backup file. Throws with a readable message on a bad file. */
export function importBackup(raw: unknown): Promise<void> {
  const r = BackupSchema.safeParse(raw);
  if (!r.success) return Promise.reject(new Error("That file isn't a Sifter backup."));
  return serial(() => browser.storage.local.set({ [KEYS.settings]: r.data.settings, [KEYS.overrides]: r.data.overrides }));
}

export function setOverride(key: string, fp: string, action: 'not-ad' | 'hide' | null): Promise<void> {
  return serial(async () => {
    const all = await loadOverrides();
    const site = { ...(all[key] ?? {}) };
    if (action === null) delete site[fp];
    else site[fp] = action;
    all[key] = site;
    await browser.storage.local.set({ [KEYS.overrides]: all });
  });
}
