import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';
import { LAUNCH_MATCHES } from './src/sites';

// See BRIEF.md §5 "Permissions": required permissions stay narrow so the install
// warning is short; everything else is requested at runtime.
export default defineConfig({
  imports: false,
  vite: () => ({
    plugins: [preact()],
    // Readable function names in a live trace (bench/live.ts); never for a release.
    ...(process.env.SIFTER_NOMINIFY ? { build: { minify: false } } : {}),
    // Hide latency and flips (src/content/trace.ts) for bench:live; a release build compiles them out.
    define: { 'import.meta.env.SIFTER_TRACE': JSON.stringify(process.env.SIFTER_TRACE === '1') },
  }),
  manifest: {
    name: 'Sifter',
    // The store shows this as the listing summary (132 characters max); keep it equal to
    // docs/STORE_LISTING.md "Summary". No list of site names: the store rejected 1.3.0 for
    // that as keyword spam.
    description: 'Hides the sponsored posts your ad blocker misses: the ones a site places in your feed or search results itself.',
    // activeTab is not in the brief's list; it carries no install warning and is what
    // lets the popup read the current tab's hostname to offer "Hide ads on <site>".
    permissions: ['storage', 'scripting', 'activeTab', 'contextMenus'],
    host_permissions: LAUNCH_MATCHES,
    optional_host_permissions: ['https://*/*'],
    homepage_url: 'https://github.com/danieljpuusitalo/sifter',
    // Highest feature floor in the code: storage setAccessLevel (102), scripting
    // registerContentScripts (96), adapter `:has()` selectors (105). 116 is margin
    // above that. The floor is set by API availability only: e2e runs on current
    // Chromium (Linux, macOS, Windows), never on 116 itself.
    minimum_chrome_version: '116',
  },
});
