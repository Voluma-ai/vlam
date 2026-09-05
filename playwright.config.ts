import { defineConfig, devices } from '@playwright/test';

/** Browser checks run both requested rendering backends independently. */
export default defineConfig({
  testDir: './browser-tests',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader-webgl'] },
      },
    },
    {
      name: 'chromium-webgl2',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--use-angle=swiftshader-webgl', '--disable-webgpu'] },
      },
    },
  ],
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/src/viewer/backend-probe.html',
    reuseExistingServer: !process.env.CI,
  },
});
