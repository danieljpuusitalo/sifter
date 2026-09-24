import { browser } from 'wxt/browser';
import type { BgRequest } from './messages';

/**
 * Ask the service worker. A failed handler replies `{ error }` rather than
 * rejecting (a message reply can't carry an exception), so turn that back into
 * a throw: otherwise the popup and options page would read the error object as
 * a result and report success.
 */
export async function bg<T>(msg: BgRequest): Promise<T> {
  const reply: unknown = await browser.runtime.sendMessage(msg);
  if (reply && typeof reply === 'object' && 'error' in reply) {
    throw new Error(String((reply as { error: unknown }).error));
  }
  return reply as T;
}
