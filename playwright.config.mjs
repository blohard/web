import { defineConfig, devices } from '@playwright/test'

const production = process.env.BLOHARD_UI_BUILD === 'production'

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: true,
  ...(production ? { testMatch: ['layout.spec.mjs', 'paging-stability.spec.mjs'] } : {}),
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:8790', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1100, height: 800 } } }],
  webServer: {
    command: production
      ? 'npx vite build --outDir dist-layout --emptyOutDir && npx vite preview --outDir dist-layout --host 127.0.0.1 --port 8790 --strictPort'
      : 'npm run dev -- --host 127.0.0.1 --port 8790 --strictPort',
    url: 'http://127.0.0.1:8790',
    reuseExistingServer: false,
    env: { VITE_ACCOUNT_KEYS_ADDRESS: '', VITE_ACCOUNT_KEYS_DEV_FUND: '',
      VITE_MOBILE_WALLET_NAME: 'Test Wallet · app', VITE_MOBILE_WALLET_MODULE: '/wallets/test-wallet.js' },
  },
})
