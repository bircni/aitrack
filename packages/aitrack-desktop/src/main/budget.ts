import { saveConfig, tryLoadConfig } from 'aitrack-lib/config';
import type { Config } from 'aitrack-lib/configTypes';
import { budgetStatus, type BudgetStatus } from 'aitrack-lib/data/budget';

export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

export function calendarMonthSpend(
  days: ReadonlyArray<{ day: string; costUsd: number }>,
  today: string,
): number {
  const month = today.slice(0, 7);
  return days
    .filter((day) => day.day.startsWith(`${month}-`))
    .reduce((sum, day) => sum + day.costUsd, 0);
}

export function withMonthlyBudget(config: Config, monthlyUSD: number | null): Config {
  if (monthlyUSD === null || !(monthlyUSD > 0)) {
    const { budget: _budget, ...rest } = config;
    return rest;
  }
  return { ...config, budget: { ...config.budget, monthlyUSD } };
}

export interface BudgetView {
  monthlyUSD: number | null;
  status: BudgetStatus | null;
}

export function readBudget(
  days: ReadonlyArray<{ day: string; costUsd: number }>,
  today: string,
): BudgetView {
  const monthlyUSD = tryLoadConfig()?.budget?.monthlyUSD ?? null;
  return {
    monthlyUSD,
    status: monthlyUSD === null ? null : budgetStatus(calendarMonthSpend(days, today), monthlyUSD),
  };
}

export function writeMonthlyBudget(monthlyUSD: number | null): { ok: boolean; message: string } {
  const config = tryLoadConfig();
  if (config === null) {
    return {
      ok: false,
      message: 'The budget lives in the aitrack config, and this machine has no config yet.',
    };
  }
  saveConfig(withMonthlyBudget(config, monthlyUSD));
  return { ok: true, message: monthlyUSD === null ? 'Budget cleared.' : 'Budget saved.' };
}
