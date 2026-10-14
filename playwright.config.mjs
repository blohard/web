import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:8790', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1100, height: 800 } } }],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 8790 --strictPort',
    url: 'http://127.0.0.1:8790',
    reuseExistingServer: false,
    env: { VITE_ACCOUNT_KEYS_ADDRESS: '', VITE_ACCOUNT_KEYS_DEV_FUND: '',
      VITE_MOBILE_WALLET_NAME: 'Test Wallet · app', VITE_MOBILE_WALLET_MODULE: '/wallets/test-wallet.js' },
  },
})
