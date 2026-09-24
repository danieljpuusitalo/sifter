import { z } from 'zod';
import { browser } from 'wxt/browser';

// Everything persists to browser.storage.local (hard rule 11: the service worker
// can be killed at any moment, so no state lives only in memory). Only trusted
// contexts (service worker, popup, options) touch storage; the background locks
// storage.local to TRUSTED_CONTEXTS so content scripts can never read an API key
// (hard rule 4). Content scripts get what they need by message.

export const HideModeSchema = z.enum(['collapse', 'blur', 'hide']);

export const SiteSettingSchema = z.object({ enabled: z.boolean() });

export const SettingsSchema = z.object({
  version: z.literal(1).default(1),
  /** Keyed by site key (hostname without a leading "www."). Missing = default for that site. */
  sites: z.record(z.string(), SiteSettingSchema).default({}),
  /** Non-launch hosts the user switched on from the popup; they use the generic extractor. */
  optInHosts: z.array(z.string()).default([]),
  pausedUntil: z.number().nullable().default(null),
  hideMode: HideModeSchema.default('collapse'),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const OverridesSchema = z.record(
  z.string(), // site key
  z.record(z.string(), z.enum(['not-ad', 'hide'])), // fingerprint -> action
);
export type Overrides = z.infer<typeof OverridesSchema>;

export function siteKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

/** Parse stored settings; anything corrupt falls back to defaults instead of breaking the extension. */
export function parseSettings(raw: unknown): Settings {
  const r = SettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : defaultSettings();
}

export function parseOverrides(raw: unknown): Overrides {
  const r = OverridesSchema.safeParse(raw ?? {});
  return r.success ? r.data : {};
}

export function isSiteEnabled(settings: Settings, key: string, isLaunchSite: boolean): boolean {
  const s = settings.sites[key];
  if (s) return s.enabled;
  return isLaunchSite || settings.optInHosts.includes(key);
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
