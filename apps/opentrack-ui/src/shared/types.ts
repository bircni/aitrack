import type { ProjectUsage } from 'aitrack-lib/data/types';
import type { ProviderKey } from 'aitrack-lib/providers/descriptors';
import type { QuotaError, QuotaProviderKey, QuotaSnapshot } from 'aitrack-lib/quota/types';

export type { QuotaError, QuotaProviderKey, QuotaWindow } from 'aitrack-lib/quota/types';

export interface Spend {
  tokens: number;
  costUSD: number;
  /** Some of the tokens were priced; without it `costUSD` is not a real $0. */
  hasCost: boolean;
  hasUnpricedTokens?: boolean;
}

interface ModelUsage extends Spend {
  model: string;
}

export interface PeriodUsage extends Spend {
  models: ModelUsage[];
}

export const EMPTY_PERIOD: PeriodUsage = { tokens: 0, costUSD: 0, hasCost: false, models: [] };

/** `project` is `owner/repo`, `(no remote)`, or `(unattributed)` for what no project explains. */
export type ProjectUsageEntry = ProjectUsage;

/** Projects per period, by cost; the unattributed remainder comes last. */
export interface ProjectUsages {
  today: ProjectUsageEntry[];
  last7Days: ProjectUsageEntry[];
  last30Days: ProjectUsageEntry[];
  allTime: ProjectUsageEntry[];
}

export interface DailyUsage {
  date: string;
  costUSD: number;
  /** Part of the day has no price, so `costUSD` is only what could be priced. */
  hasUnpricedTokens?: boolean;
}

export interface ProviderUsage {
  today: PeriodUsage;
  yesterday: PeriodUsage;
  last7Days: PeriodUsage;
  last30Days: PeriodUsage;
  allTime: PeriodUsage;
  daily: DailyUsage[];
}

export type ProviderUsages = Partial<Record<ProviderKey, ProviderUsage>>;

export interface MachineUsage {
  name: string;
  timezone: string;
  /** Empty until the machine first syncs. */
  lastUpdated: string;
  /** The machine opentrack runs on. */
  current: boolean;
  providers: ProviderUsages;
}

export interface ProviderState {
  key: ProviderKey;
  label: string;
  quota?: QuotaSnapshot;
  quotaError?: QuotaError;
  /** Epoch ms a provider-declared retry-after ends; a refresh cannot retry its limits before then. */
  retryAt?: number;
  usage?: ProviderUsage;
  refreshing: boolean;
}

export interface AppState {
  providers: ProviderState[];
  refreshing: boolean;
  machines?: MachineUsage[];
  /** Usage read from a provider account (Cursor) rather than from any machine. */
  accountUsage?: ProviderUsages;
  /** Absent until a usage load that records projects has run. */
  projects?: ProjectUsages;
  usageError?: string;
  pullError?: string;
  usageUpdatedAt?: string;
  updatedAt?: string;
  /** Oldest `quota.fetchedAt` of the enabled providers; `updatedAt` also moves on local usage reads. */
  quotaUpdatedAt?: string;
  /** A usage load finished and found no tokens at all, rather than not having run or having failed. */
  usageEmpty?: boolean;
  syncing: boolean;
  /** The last sync's outcome, success or failure. */
  syncResult?: { ok: boolean; message: string };
}

type ThemeSetting = 'system' | 'light' | 'dark';

type TrayWindow = 'highest' | 'session' | 'weekly';

export interface Settings {
  theme: ThemeSetting;
  /** Show quotas as used or as remaining. */
  display: 'used' | 'left';
  resetDisplay: 'relative' | 'absolute';
  /** `label` is filled in by the shell from the provider registry; what is saved is ignored. */
  providers: Array<{ key: ProviderKey; label: string; enabled: boolean }>;
  launchAtLogin: boolean;
  /** Tauri global-shortcut accelerator (e.g. CommandOrControl+Shift+O), empty for none. */
  globalShortcut: string;
  notifications: boolean;
  /** Stays open on blur, shows in the taskbar and keeps where it was dragged. */
  keepOpen: boolean;
  /** Shows only the session limit of each enabled provider. */
  compact: boolean;
  /** `git pull` the aitrack data repo so other machines' usage stays current. */
  pullSyncedData: boolean;
  /** The provider the tray icon follows; `auto` takes the most used one. */
  trayProvider: 'auto' | QuotaProviderKey;
  /** Its window; `highest` takes whichever is most used. */
  trayWindow: TrayWindow;
  trayStyle: 'icon' | 'bars';
  trayColored: boolean;
}

export type Screen = 'dashboard' | 'settings';

export type DashboardView = 'providers' | 'history' | 'projects' | 'machines';

/** Why a setting the OS applies did not take; empty when all did. */
export type SettingErrors = Partial<Record<'launchAtLogin' | 'globalShortcut', string>>;

/** What the renderer can ask of the desktop shell. */
export interface OpentrackApi {
  getState: () => Promise<AppState>;
  refresh: () => Promise<void>;
  /** `aitrack sync`: push this machine's usage to the data repo. */
  sync: () => Promise<void>;
  getSettings: () => Promise<Settings>;
  saveSettings: (settings: Settings) => Promise<Settings>;
  openDashboard: (provider: QuotaProviderKey) => Promise<void>;
  quit: () => Promise<void>;
  /** Report the content height so the window can fit it. */
  fitHeight: (height: number) => void;
  hideWindow: () => void;
  onState: (listener: (state: AppState) => void) => () => void;
  onSettings: (listener: (settings: Settings) => void) => () => void;
  onScreen: (listener: (screen: Screen) => void) => () => void;
  settingErrors: () => Promise<SettingErrors>;
  onSettingErrors: (listener: (errors: SettingErrors) => void) => () => void;
  appVersion: () => Promise<string>;
  /** Asks GitHub now; a found version also arrives through `onUpdate`. */
  checkForUpdate: () => Promise<string | null>;
  /** The version a newer release offers, or null while this one is current. */
  availableUpdate: () => Promise<string | null>;
  onUpdate: (listener: (version: string) => void) => () => void;
  /** Downloads and installs the update, then restarts into it. */
  installUpdate: () => Promise<void>;
}
