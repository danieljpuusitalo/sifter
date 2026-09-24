import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';
import { LAUNCH_MATCHES } from './src/sites';

// See BRIEF.md §5 "Permissions": required permissions stay narrow so the install
// warning is short; everything else is requested at runtime.
export default defineConfig({
  imports: false,
  vite: () => ({
    plugins: [preact()],
  }),
  manifest: {
    name: 'Sifter',
    description: 'Hides the ads your ad blocker misses: sponsored posts and promoted results inside the feed.',
    // activeTab is not in the brief's list; it carries no install warning and is what
    // lets the popup read the current tab's hostname to offer "Hide ads on <site>".
    permissions: ['storage', 'scripting', 'activeTab', 'contextMenus'],
    host_permissions: LAUNCH_MATCHES,
    optional_host_permissions: ['https://*/*'],
    homepage_url: 'https://github.com/danieljpuusitalo/sifter',
    // Highest feature floor in the code: storage setAccessLevel (102), scripting
    // registerContentScripts (96), adapter `:has()` selectors (105). 116 adds margin
    // and is the oldest Chrome the e2e suite has been run against.
    minimum_chrome_version: '116',
  },
});
