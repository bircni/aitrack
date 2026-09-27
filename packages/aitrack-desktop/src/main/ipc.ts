import { writeFileSync } from 'node:fs';

import { buildUsageReport } from 'aitrack-lib/data/usageReport';
import { renderUsageReportCsv } from 'aitrack-lib/display/csv/report';
import { renderReceiptPdf } from 'aitrack-lib/display/pdf/receipt';
import { getClaudePaths } from 'aitrack-lib/readers/claude';
import { getCodexPaths } from 'aitrack-lib/readers/codex';
import { buildLeverageReport, cursorAcceptance } from 'aitrack-lib/sessions/index';
import { app, dialog, ipcMain, type BrowserWindow } from 'electron';

import { contracts, type Channel, type RequestOf } from '../shared/contracts.js';
import { localDay, readBudget, writeMonthlyBudget } from './budget.js';
import { collectDoctorChecks } from './doctor.js';
import { enabledProviders, ingestAll } from './ingest.js';
import type { DesktopStore } from './store.js';
import { connectDataRepo, machines, previewPush, pushDataRepo, syncStatus } from './sync.js';

export interface DesktopContext {
  store: DesktopStore;
  window: () => BrowserWindow | null;
  paused: () => boolean;
  setPaused: (paused: boolean) => void;
  setBackground: (background: boolean) => void;
}

function handle<C extends Channel>(channel: C, listener: (payload: RequestOf<C>) => unknown): void {
  const contract = contracts[channel];
  ipcMain.handle(channel, async (_event, payload: unknown) => {
    const request = contract.request.parse(payload) as RequestOf<C>;
    const result = await listener(request);
    return contract.response.parse(result);
  });
}

export function registerIpc(context: DesktopContext): void {
  handle('bootstrap', () => settingsOf(context));

  handle('sessions:list', () => context.store.listSessions());
  handle('sessions:get', (payload) => context.store.getSession(payload.id));
  handle('sessions:rate', (body) => {
    context.store.rateSession(body.id, body.rating, body.note);
    notify(context);
    return { ok: true };
  });
  handle('commits:list', () => context.store.listCommits());
  handle('commits:files', (payload) => context.store.commitFiles(payload.id));
  handle('commits:links', (payload) => context.store.linksForCommit(payload.id));
  handle('commits:decide', (body) => {
    context.store.decideLink(body.commitId, body.sessionId, body.decision);
    notify(context);
    return { ok: true };
  });
  handle('repos:list', () => context.store.listRepos());
  handle('repos:update', (body) => {
    context.store.updateRepo(body.id, body.enabled, body.testGlobs);
    notify(context);
    return { ok: true };
  });
  handle('cost:get', () => context.store.usageDays());
  handle('cost:budget', () => readBudget(context.store.usageDays(), localDay(new Date())));
  handle('cost:models', (body) => context.store.modelCosts(body.from, body.to));
  handle('leverage:get', (body) => {
    const data = context.store.metricInputs();
    const report = buildLeverageReport({
      ...data,
      window: { from: body.from, to: body.to },
      now: new Date().toISOString(),
      repoId: body.repoId,
      provider: body.provider,
    });
    const tabs = context.store.cursorAcceptance();
    return { report, tabs: cursorAcceptance(tabs.suggested, tabs.accepted) };
  });
  handle('machines:list', () => machines());
  handle('settings:get', () => settingsOf(context));
  handle('settings:update', (body) => {
    if (body.onboarded !== undefined) context.store.setSetting('onboarded', body.onboarded);
    if (body.theme !== undefined) context.store.setSetting('theme', body.theme);
    if (body.claude !== undefined) context.store.setSetting('claude', body.claude);
    if (body.codex !== undefined) context.store.setSetting('codex', body.codex);
    if (body.cursor !== undefined) context.store.setSetting('cursor', body.cursor);
    if (body.paused !== undefined) context.setPaused(body.paused);
    if (body.openAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: body.openAtLogin });
    }
    if (body.linkBeforeMin !== undefined) {
      context.store.setSetting('linkBeforeMin', body.linkBeforeMin);
    }
    if (body.linkAfterHours !== undefined) {
      context.store.setSetting('linkAfterHours', body.linkAfterHours);
    }
    if (body.background !== undefined) {
      context.store.setSetting('background', body.background);
      context.setBackground(body.background);
    }
    if (body.rateReminder !== undefined)
      context.store.setSetting('rateReminder', body.rateReminder);
    const budget = body.budgetMonthly === undefined ? null : writeMonthlyBudget(body.budgetMonthly);
    notify(context);
    return budget ?? { ok: true, message: 'Saved' };
  });
  handle('sync:status', () => syncStatus());
  handle('sync:preview', () => previewPush());
  handle('sync:connect', (body) => connectDataRepo(body.confirm, body.repoUrl));
  handle('cost:refresh', async () => {
    await ingestAll(context.store, { ...enabledProviders(context.store), refreshCursor: true });
    notify(context);
    return { ok: true, message: 'Cursor usage refreshed.' };
  });
  handle('sources:get', () => ({
    claude: getClaudePaths(),
    codex: getCodexPaths(),
    linkBeforeMin: context.store.setting<number>('linkBeforeMin', 5),
    linkAfterHours: context.store.setting<number>('linkAfterHours', 6),
  }));
  handle('sync:push', (body) => pushDataRepo(body.confirm));
  handle('diagnostics:get', async () => ({
    checks: await collectDoctorChecks(),
    log: context.store.recentLog(),
  }));
  handle('export:save', async (body) => {
    const { kind } = body;
    const flags = enabledProviders(context.store);
    const providers = [
      ...(flags.claude ? ['claude'] : []),
      ...(flags.codex ? ['codex'] : []),
      ...(flags.cursor ? ['cursor'] : []),
    ];
    const report = await buildUsageReport({ period: 'all', providers, refreshLive: false });
    if (!report || report.rowCount === 0) return { ok: false, message: 'No usage to export' };
    const saveOptions = {
      defaultPath: kind === 'pdf' ? 'aitrack-usage.pdf' : 'aitrack-usage.csv',
      filters:
        kind === 'pdf'
          ? [{ name: 'PDF', extensions: ['pdf'] }]
          : [{ name: 'CSV', extensions: ['csv'] }],
    };
    const parent = context.window();
    const chosen =
      parent === null
        ? await dialog.showSaveDialog(saveOptions)
        : await dialog.showSaveDialog(parent, saveOptions);
    if (chosen.canceled || chosen.filePath === '') return { ok: false, message: 'Cancelled' };
    if (kind === 'csv') {
      writeFileSync(chosen.filePath, renderUsageReportCsv(report));
    } else {
      writeFileSync(chosen.filePath, await renderReceiptPdf(report));
    }
    return { ok: true, message: chosen.filePath };
  });
  handle('ingest:rebuild', async () => {
    context.store.log('rebuild', 'full');
    const summary = await ingestAll(context.store, {
      ...enabledProviders(context.store),
      full: true,
    });
    notify(context);
    return summary;
  });
}

function settingsOf(context: DesktopContext): {
  platform: string;
  onboarded: boolean;
  theme: 'system' | 'dark' | 'light';
  claude: boolean;
  codex: boolean;
  cursor: boolean;
  paused: boolean;
  background: boolean;
  openAtLogin: boolean;
  rateReminder: boolean;
} {
  return {
    platform: process.platform,
    onboarded: context.store.setting<boolean>('onboarded', false),
    theme: context.store.setting<'system' | 'dark' | 'light'>('theme', 'system'),
    claude: context.store.setting<boolean>('claude', true),
    codex: context.store.setting<boolean>('codex', true),
    cursor: context.store.setting<boolean>('cursor', true),
    paused: context.paused(),
    background: context.store.setting<boolean>('background', true),
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    rateReminder: context.store.setting<boolean>('rateReminder', false),
  };
}

export function notify(context: DesktopContext): void {
  context.window()?.webContents.send('store:changed');
}
