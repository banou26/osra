import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  // 5s is a deliberate hang-catcher locally; CI needs headroom for WebKit cold starts
  timeout: process.env.CI ? 15_000 : 5_000,
  retries: process.env.CI ? 1 : 0,
  fullyParallel: true,
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  webServer: [
    {
      command: 'npm run start-server',
      url: 'http://localhost:3000'
    },
    {
      command: 'node tests/ws-relay.mjs',
      port: 3001
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--mute-audio'] } },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], launchOptions: { firefoxUserPrefs: { 'media.volume_scale': '0.0' } } },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ]
})
