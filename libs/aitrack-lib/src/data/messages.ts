// Dependency-free so config.ts can import it without a cycle through emptyState.ts.

/** The command that fixes an unconfigured install. */
export const INIT_HINT = 'npx aitrack init';

export const NO_CONFIG_MESSAGE = `No config found. Run: ${INIT_HINT}`;

export const REPO_NOT_CLONED_MESSAGE = `Repo not cloned. Run: ${INIT_HINT}`;

export const REPO_URL_UNSET_MESSAGE = `Warning: repoUrl is not set. Run: ${INIT_HINT}`;
