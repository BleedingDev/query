import { defineConfig } from 'vitest/config'
import solid from '@solidjs/vite-plugin'

import packageJson from './package.json'

export default defineConfig({
  plugins: [solid()],
  // fix from https://github.com/vitest-dev/vitest/issues/6992#issuecomment-2509408660
  // Use Core's published exports, not its custom-condition TypeScript sources.
  // Solid Query tests import local source directly; query-test-utils exports it by default.
  resolve: {
    alias: {
      'solid-js/web': '@solidjs/web',
    },
  },
  ssr: {
    noExternal: ['@solidjs/testing-library'],
  },
  test: {
    name: packageJson.name,
    dir: './src',
    watch: false,
    environment: 'jsdom',
    setupFiles: ['test-setup.ts'],
    coverage: {
      enabled: !!process.env.CI,
      provider: 'istanbul',
      include: ['src/**/*'],
      exclude: ['src/__tests__/**'],
    },
    typecheck: { enabled: true },
    restoreMocks: true,
    server: {
      deps: {
        inline: ['@solidjs/testing-library'],
      },
    },
  },
})
