/** Shape of `~/.config/aitrack/config.json`. */
interface BudgetConfig {
  /** Estimated-cost ceiling for the calendar month, in USD. `usage thismonth` flags progress against it. */
  monthlyUSD?: number;
}

export interface Config {
  repoUrl: string;
  /** Stable machine identifier for data/{machineId}.json; defaults to the short hostname. */
  machineId?: string;
  /** Comma-separated Claude Code project roots; defaults to the standard Claude locations. */
  claudeProjectsDir?: string;
  /** Comma-separated Codex session roots; defaults to the standard Codex locations. */
  codexSessionsDir?: string;
  budget?: BudgetConfig;
}
