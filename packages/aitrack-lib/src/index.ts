/**
 * The public surface of aitrack-lib.
 *
 * Everything here is also reachable at its own subpath (`aitrack-lib/data/types`
 * and so on), which is what the `aitrack` CLI imports — a command that needs one
 * module should not pull the renderers in with it. This barrel exists for
 * consumers who just want "the library" and do not care where a symbol lives.
 */

// Configuration and identity
export type { Config } from './configTypes.js';
export * from './config.js';
export * from './machineId.js';
export * from './paths.js';

// Cross-cutting helpers
export * from './constants.js';
export * from './env.js';
export * from './errors.js';
export * from './output.js';
export { packageVersion, readPackageVersion } from './version.js';

// The data model and the reports built from it
export * from './data/types.js';
export * from './data/aggregate.js';
export * from './data/budget.js';
export * from './data/dayMap.js';
export * from './data/localData.js';
export * from './data/schema.js';
export * from './data/topUsage.js';
export * from './data/usageData.js';
export * from './data/usagePeriods.js';
export * from './data/usageReport.js';
export * from './data/validate.js';

// Providers and the readers behind them
export * from './providers/index.js';
export { getClaudePaths, readClaudeData } from './readers/claude.js';
export { getCodexPaths, readCodexData } from './readers/codex.js';
export { type ReadCursorDataOptions, readCursorData } from './readers/cursor/index.js';

// Pricing
export * from './pricing/resolve.js';

// The data repo: cloning it, reading machine files, writing ours back
export {
  adoptPendingDataFiles,
  cloneRepo,
  commitAndPush,
  commitDataChanges,
  hasMachineDataChanges,
  hasUnpushedCommits,
  isCloned,
  listDataFiles,
  listPendingDataFiles,
  migrateMachineDataFiles,
  pull,
  pushPendingCommits,
  readDataFile,
  removeLocalClone,
  removePendingMachineFile,
  writePendingMachineFile,
} from './git.js';

// Renderers
export * from './display/format.js';
export * from './display/providers.js';
export * from './display/renderOptions.js';
export * from './display/terminalTable.js';
export * from './display/tui.js';
export { renderUsageReportCsv } from './display/csv/report.js';
export { type HtmlRenderOptions, renderToHtml } from './display/html/render.js';
export { renderReceiptPdf } from './display/pdf/receipt.js';
export { renderToPng } from './display/renderPng.js';
