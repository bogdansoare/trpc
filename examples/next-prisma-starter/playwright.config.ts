import { PlaywrightTestConfig, devices } from '@playwright/test';

const opts = {
  // launch headless on CI, in browser locally
  headless: !!process.env.CI || !!process.env.PLAYWRIGHT_HEADLESS,
  // collectCoverage: !!process.env.PLAYWRIGHT_HEADLESS,
  executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH,
};
const config: PlaywrightTestConfig = {
  testDir: './playwright',
  outputDir: './playwright/test-results',
  // 'github' for GitHub Actions CI to generate annotations, plus a concise 'dot'
  // default 'list' when running locally
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    headless: opts.headless,
    launchOptions: {
      executablePath: opts.executablePath,
    },
    video: 'on',
  },
};

export default config;
