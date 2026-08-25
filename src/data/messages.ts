/**
 * Remediation strings shared across commands.
 *
 * Eight near-variants of "Run: npx aitrack init" had drifted apart in wording
 * and punctuation. This module is deliberately dependency-free so that
 * `config.ts` can use it without importing `emptyState.ts`, which reads config
 * and would form a cycle.
 */

/** The command that fixes an unconfigured install. */
export const INIT_HINT = 'npx aitrack init';

export const NO_CONFIG_MESSAGE = `No config found. Run: ${INIT_HINT}`;

export const REPO_NOT_CLONED_MESSAGE = `Repo not cloned. Run: ${INIT_HINT}`;

export const SYNC_REPO_NOT_CLONED_MESSAGE = `Sync enabled but repo not cloned. Run: ${INIT_HINT}`;

export const REPO_URL_UNSET_MESSAGE = `Warning: repoUrl is not set. Run: ${INIT_HINT}`;
