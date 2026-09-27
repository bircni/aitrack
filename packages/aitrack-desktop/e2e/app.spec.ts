import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const desktop = join(import.meta.dirname, '..');
const shots = join(desktop, 'e2e/artifacts');

test('onboarding, a linked session, a rating that survives relaunch, and both themes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aitrack-desktop-e2e-'));
  mkdirSync(shots, { recursive: true });
  try {
    writeFixture(home);
    const first = await launch(home);
    const page = await first.firstWindow();
    await expect(page.getByRole('heading', { name: 'Your sessions stay yours.' })).toBeVisible();
    await page.getByRole('button', { name: 'Start watching' }).click();
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByLabel('Theme').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('link', { name: 'Sessions' }).click();
    await expect(page.getByText('app.ts').first()).toBeVisible();
    await expect(page.getByText(/files this commit touched|Committed/u).first()).toBeVisible();
    await page.getByRole('button', { name: 'Kept' }).click();
    await expect(page.getByRole('button', { name: 'Kept' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await settle(page);
    await page.screenshot({ path: join(shots, 'sessions-dark.png') });

    await page.getByRole('link', { name: 'Commits' }).click();
    await page.getByRole('button', { name: 'add app' }).click();
    await expect(page.getByRole('heading', { name: 'Linked sessions' })).toBeVisible();
    await expect(page.getByText(/files this commit touched|Committed/u).first()).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(shots, 'commits-dark.png') });

    await page.getByRole('link', { name: 'Overview' }).click();
    await expect(page.getByRole('heading', { name: 'What happened today' })).toBeVisible();
    await expect(page.getByText('Nothing started today.')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await settle(page);
    await page.screenshot({ path: join(shots, 'overview-dark.png') });

    await page.getByRole('link', { name: 'Cost' }).click();
    await expect(page.getByRole('button', { name: /Last 30 days/u })).toBeVisible();
    await page.getByLabel('Window').selectOption('7');
    await expect(page.getByRole('button', { name: /Last 7 days/u })).toBeVisible();
    await expect(page.getByRole('button', { name: /Previous 7 days/u })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(shots, 'cost-dark.png') });

    await page.getByRole('link', { name: 'Leverage' }).click();
    await expect(page.getByText('Linked, and on your own')).toBeVisible();
    await expect(
      page.getByText('1 kept, 0 reworked, 0 discarded, 0 unrated in this window.'),
    ).toBeVisible();
    await expect(page.getByText('Test lines').first()).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(shots, 'leverage-dark.png') });

    await page.evaluate(() => {
      window.location.hash = '#/tokens';
    });
    await expect(page.getByText('Depth 0')).toBeVisible();
    await expect(page.getByText('Chart')).toBeVisible();
    await settle(page);

    const reduced = await page
      .locator('.mesh')
      .evaluate((element) => getComputedStyle(element).animationName);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const still = await page
      .locator('.mesh')
      .evaluate((element) => getComputedStyle(element).animationName);
    expect(reduced === 'drift' || reduced === 'none').toBe(true);
    expect(still).toBe('none');
    await settle(page);
    await expect.soft(page).toHaveScreenshot('tokens-dark.png', {
      animations: 'disabled',
      fullPage: true,
    });
    await page.screenshot({ path: join(shots, 'tokens-dark.png') });

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('button', { name: 'Push to your data repo' })).toHaveCount(0);
    await expect(page.getByText('Available on PATH')).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(shots, 'settings-dark.png') });
    await page.getByLabel('Theme').selectOption('light');
    await page.getByRole('link', { name: 'Overview' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByText('Today', { exact: true })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(shots, 'overview-light.png') });
    await page.evaluate(() => {
      window.location.hash = '#/tokens';
    });
    await expect(page.getByText('Depth 0')).toBeVisible();
    await expect(page.getByText('Chart')).toBeVisible();
    await settle(page);
    await expect.soft(page).toHaveScreenshot('tokens-light.png', {
      animations: 'disabled',
      fullPage: true,
    });
    await page.screenshot({ path: join(shots, 'tokens-light.png') });
    await first.close();

    const second = await launch(home);
    const again = await second.firstWindow();
    await again.getByRole('link', { name: 'Sessions' }).click();
    await expect(again.getByRole('button', { name: 'Kept' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await second.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => {
      const timing = animation.effect?.getComputedTiming();
      return timing?.iterations !== Number.POSITIVE_INFINITY;
    });
    await Promise.all(finite.map((animation) => animation.finished));
  });
}

function launch(home: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(desktop, 'out/main/index.js')],
    cwd: desktop,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AITRACK_DESKTOP_SHOW: '1',
      AITRACK_USER_DATA: join(home, 'electron-data'),
      AITRACK_CLAUDE_PROJECTS_DIRS: join(home, 'claude-projects'),
      AITRACK_CODEX_SESSION_DIRS: join(home, 'codex'),
    },
  });
}

function writeFixture(home: string): void {
  const projects = join(home, 'claude-projects', 'demo');
  const repo = join(home, 'repo');
  mkdirSync(projects, { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(home, 'codex'), { recursive: true });
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const value = 1;\n');
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_AUTHOR_DATE: '2026-09-20T12:05:00Z',
    GIT_COMMITTER_DATE: '2026-09-20T12:05:00Z',
  };
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, env: gitEnv });
  execFileSync('git', ['add', 'src/app.ts'], { cwd: repo, env: gitEnv });
  execFileSync('git', ['commit', '-m', 'add app'], { cwd: repo, env: gitEnv });
  const file = join(repo, 'src', 'app.ts');
  writeFileSync(
    join(projects, 'sess.jsonl'),
    `${JSON.stringify({
      type: 'user',
      timestamp: '2026-09-20T12:00:00.000Z',
      sessionId: 'sess',
      cwd: repo,
      gitBranch: 'main',
      message: { role: 'user', content: 'please edit the app' },
    })}\n${JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-20T12:04:00.000Z',
      sessionId: 'sess',
      requestId: 'r1',
      message: {
        id: 'msg1',
        model: 'claude-3-5-sonnet-20241022',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }],
      },
    })}\n`,
  );
}
