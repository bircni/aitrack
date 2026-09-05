/**
 * Shape of `~/.config/aitrack/config.json`.
 *
 * These lived in `data/types.ts` next to the domain vocabulary, but the data
 * layer neither produces nor validates them — `config.ts` does. Keeping them
 * here stops the domain types from depending on a CLI concern.
 */
interface BudgetConfig {
  /** Estimated-cost ceiling for the calendar month, in USD. `usage thismonth` flags progress against it. */
  monthlyUSD?: number;
}

export interface Config {
  repoUrl: string;
  /** Stable machine identifier for data/{machineId}.json; defaults to os.hostname(). */
  machineId?: string;
  /** Comma-separated Claude Code project roots; defaults to the standard Claude locations. */
  claudeProjectsDir?: string;
  /** Comma-separated Codex session roots; defaults to the standard Codex locations. */
  codexSessionsDir?: string;
  budget?: BudgetConfig;
}
