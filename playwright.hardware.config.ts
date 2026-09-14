import { defineConfig } from '@playwright/test';

/**
 * Native-GPU projection/SH verification. Kept separate from the SwiftShader
 * CI configuration so a missing hardware adapter is a failure, never a skip.
 */
export default defineConfig({
  testDir: './browser-tests',
  testMatch: '**/hardware-projection.spec.ts',
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4174', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium-webgpu-hardware',
      use: {
        // Do not use Playwright's Desktop Chrome device preset here: it
        // overrides navigator.userAgent with the bundled browser version and
        // would make the recorded provenance misleading.
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          // The bundled Playwright Chromium is the SwiftShader CI browser here.
          // Native validation intentionally uses the installed desktop browser;
          // another host can name its equivalent without editing this config.
          executablePath: process.env.VLAM_HARDWARE_CHROMIUM ?? '/usr/bin/chromium',
          // Chromium's headless compositor may select SwiftShader even when the
          // desktop session exposes the hardware adapter.
          headless: false,
          args: [
            '--enable-gpu',
            '--ignore-gpu-blocklist',
            '--enable-unsafe-webgpu',
            '--enable-dawn-features=allow_unsafe_apis',
            '--enable-webgpu-developer-features',
            '--use-gpu-in-tests',
            '--enable-accelerated-2d-canvas',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174/src/viewer/projection-probe.html',
    reuseExistingServer: !process.env.CI,
  },
});
