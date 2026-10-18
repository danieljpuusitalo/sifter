import type { BgRequest } from './messages';
import { siteKey } from './sites';
import { BackupSchema, clearOverrides, importBackup, loadSettings, suggestedOn, updateSettings, withSelf } from './storage/settings';

// The service worker's request gate and the extension-page-only writes. Kept out
// of entrypoints/background.ts so they can be tested without a service worker.

/** Content scripts may only read their own site's context, and record overrides and the learned profile id for it. */
export const CONTENT_SCRIPT_REQUESTS = new Set<BgRequest['type']>(['sifter:getContext', 'sifter:setOverride', 'sifter:setSelf']);

/** Longest key `clearOverrides` accepts: a hostname. */
const MAX_KEY_LEN = 253;

type Sender = { id?: string; url?: string };

/**
 * Extension pages may send anything. A content script runs inside a site's page,
 * which could be compromised, so it may only ask about its own site: the hostname
 * comes from the sender's URL, never from the message.
 */
export function authorize(msg: BgRequest, sender: Sender, self: { id: string; baseUrl: string }): BgRequest | null {
  if (sender.id !== self.id) return null;
  if (sender.url?.startsWith(self.baseUrl)) return msg;
  if (!CONTENT_SCRIPT_REQUESTS.has(msg.type) || !sender.url) return null;
  let hostname: string;
  try {
    hostname = new URL(sender.url).hostname;
  } catch {
    return null;
  }
  return { ...msg, hostname } as BgRequest;
}

/**
 * Record the viewer's profile id for a site, or forget it (null). While suggested is
 * off there, a learned id is ignored: nothing needs it, so it is never stored.
 */
export async function storeSelf(hostname: string, id: string | null): Promise<void> {
  const key = siteKey(hostname);
  const stored = await loadSettings();
  if (id !== null && !suggestedOn(stored, key)) return;
  // Only a change writes: the page re-learns on every visit, and each write re-decides open tabs.
  if (stored.sites[key]?.self === (id ?? undefined)) return;
  await updateSettings((s) => withSelf(s, key, id));
}

export type AdminRequest = Extract<BgRequest, { type: 'sifter:importBackup' | 'sifter:clearOverrides' }>;

/**
 * The options page's whole-store writes. They go through the service worker, so
 * they queue behind its own settings writes (`serial` only orders writes within
 * one JS context). A bad payload is answered with `{ error }`, never stored.
 */
export async function runAdmin(msg: AdminRequest): Promise<{ ok: true } | { error: string }> {
  switch (msg.type) {
    case 'sifter:importBackup':
      // The same validation the options page used to run itself.
      if (!BackupSchema.safeParse(msg.backup).success) return { error: "That file isn't a Sifter backup." };
      await importBackup(msg.backup);
      return { ok: true };
    case 'sifter:clearOverrides':
      if (msg.key !== null && (typeof msg.key !== 'string' || msg.key.length === 0 || msg.key.length > MAX_KEY_LEN)) return { error: 'invalid key' };
      await clearOverrides(msg.key);
      return { ok: true };
  }
}
