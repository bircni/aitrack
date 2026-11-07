import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  describeInvalidConfig,
  localMachineId,
  readConfig,
  resolveMachineId,
  saveConfig,
} from 'aitrack-lib/config';
import { errorMessage } from 'aitrack-lib/errors';
import {
  adoptPendingDataFiles,
  cloneOriginUrl,
  cloneRepo,
  isCloned,
  LOCAL_REPO,
  migrateMachineDataFiles,
  replaceLocalClone,
} from 'aitrack-lib/git';
import { runGitAsync } from 'aitrack-lib/git/exec';
import { redactUrl, sameRemote } from 'aitrack-lib/git/remote';
import { machineIdValidationError, normalizeMachineId } from 'aitrack-lib/machineId';
import { log } from 'aitrack-lib/output';
import prompts from 'prompts';

import { EXIT_FAILURE, UsageError } from '../cli/errors.js';

async function promptConfirm(name: string, message: string): Promise<boolean | undefined> {
  const answers = await prompts({ type: 'confirm', name, message, initial: false });
  const answer: unknown = answers[name];
  return typeof answer === 'boolean' ? answer : undefined;
}

async function promptRepoUrl(): Promise<string | undefined> {
  const answers = await prompts<'repoUrl'>({
    type: 'text',
    name: 'repoUrl',
    message: 'Git remote URL (SSH or HTTPS):',
    hint: 'e.g. git@github.com:you/aitrack-data.git',
    validate: (v: string) => v.trim().length > 0 || 'URL is required',
  });
  const repoUrl: unknown = answers.repoUrl;
  return typeof repoUrl === 'string' ? repoUrl.trim() : undefined;
}

async function promptMachineId(initial: string): Promise<string | undefined> {
  const answers = await prompts<'machineId'>({
    type: 'text',
    name: 'machineId',
    message: 'Machine name (used as data filename):',
    hint: 'e.g. work-laptop',
    initial,
    validate: (v: string) => machineIdValidationError(v) ?? true,
  });
  const machineId: unknown = answers.machineId;
  return typeof machineId === 'string' ? normalizeMachineId(machineId) : undefined;
}

export interface InitOptions {
  repo?: string;
  machine?: string;
}

function needsTerminal(what: string): UsageError {
  return new UsageError(`${what} Run init in a terminal, or pass --repo <url> --machine <name>.`);
}

function parseMachineFlag(machine: string): string {
  try {
    return normalizeMachineId(machine);
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
}

/** Nothing was written; scripts must not read this as a finished setup. */
function abort(): void {
  log.info('Aborted.');
  process.exitCode = EXIT_FAILURE;
}

/** Commits no remote has, even when a first push failed and left the branch with no upstream to compare to. */
function unpushedCommitCount(): Promise<number> {
  return runGitAsync(['rev-list', '--count', 'HEAD', '--not', '--remotes']).then(Number, () => 0); // No commits yet: HEAD does not resolve.
}

function recloneMessage(unpushed: number): string {
  const lead = 'Repo URL changed.';
  const ask = 'Replace the local clone with a clone of the new URL?';
  return unpushed === 0
    ? `${lead} ${ask}`
    : `${lead} The local clone holds ${String(unpushed)} commit(s) on no remote, and replacing it deletes them. ${ask}`;
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  const isInteractive = process.stdin.isTTY;
  const repoFlag = options.repo?.trim();
  if (repoFlag === '') throw new UsageError('--repo must not be empty.');
  const machineFlag = options.machine === undefined ? undefined : parseMachineFlag(options.machine);

  const loaded = readConfig();
  const existing = loaded.status === 'ok' ? loaded.config : null;

  // Prompts cannot read a pipe: they exit 0 at end of input, and treat newlines as text.
  if (!isInteractive) {
    if (repoFlag === undefined) throw needsTerminal('No terminal to ask for the git remote.');
    if (machineFlag === undefined && !existing?.machineId) {
      throw needsTerminal('No terminal to ask for the machine name.');
    }
    if (loaded.status === 'invalid') {
      throw new UsageError(
        `${describeInvalidConfig(loaded.reason)} Fix it, or run init in a terminal to overwrite it.`,
      );
    }
  }

  if (loaded.status !== 'missing') {
    if (loaded.status === 'invalid') log.warn(describeInvalidConfig(loaded.reason));
    else log.info(`Current config: repo=${redactUrl(loaded.config.repoUrl)}`);
    // On a pipe, --repo is the answer; nothing below touches another setting in the config.
    if (isInteractive) {
      const overwrite = await promptConfirm('overwrite', 'Config already exists. Overwrite?');
      if (!overwrite) {
        abort();
        return;
      }
    }
  }
  const previousMachineId = resolveMachineId(existing);

  if (repoFlag === undefined) {
    log.info('First, create an empty GitHub repository (or any git remote) for storing data.');
    log.info('Example: https://github.com/new — name it something like "aitrack-data".');
    log.info('');
  }

  const repoUrl = repoFlag ?? (await promptRepoUrl());
  if (!repoUrl) {
    abort();
    return;
  }

  // Asked before the clone changes, so giving up here leaves the setup as it was.
  const machineId =
    machineFlag ??
    (isInteractive
      ? await promptMachineId(existing?.machineId ?? localMachineId())
      : existing?.machineId);
  if (!machineId) {
    abort();
    return;
  }

  const wasCloned = isCloned();
  const originUrl = wasCloned ? cloneOriginUrl() : null;
  const isUrlChanged = originUrl !== null && !sameRemote(originUrl, repoUrl); // Unknown origin keeps the clone.

  if (isUrlChanged) {
    if (!isInteractive) {
      throw new UsageError(
        `The local clone at ${LOCAL_REPO} uses ${redactUrl(originUrl)}. Replacing it needs a confirmation, so run init in a terminal.`,
      );
    }
    const reclone = await promptConfirm('reclone', recloneMessage(await unpushedCommitCount()));
    if (!reclone) {
      abort();
      return;
    }
    log.info(`Replacing the clone at ${LOCAL_REPO} with ${redactUrl(repoUrl)}...`);
    replaceLocalClone(repoUrl);
    saveConfig({ ...existing, repoUrl }); // Already true of the clone, whatever happens to the steps below.
  } else if (wasCloned) {
    log.info(`Repo already cloned at ${LOCAL_REPO}. Skipping clone.`);
  } else {
    log.info(`Cloning ${redactUrl(repoUrl)} into ${LOCAL_REPO}...`);
    mkdirSync(dirname(LOCAL_REPO), { recursive: true });
    cloneRepo(repoUrl);
  }

  // Renames staged data too, so it must run first: an adopted file is untracked, and the rename's `git add` fails on it.
  migrateMachineDataFiles(previousMachineId, machineId);
  // Once a clone already exists, pending data may duplicate its synced current-machine file.
  let adopted = 0;
  if (existing === null || !wasCloned) {
    adopted = adoptPendingDataFiles(join(LOCAL_REPO, 'data'));
  }

  saveConfig({ ...existing, repoUrl, machineId });
  if (adopted > 0) {
    log.info(`Adopted ${String(adopted)} pending data file(s) into the repo.`);
  }

  log.info('');
  log.info('Done! Next steps:');
  log.info('  npx aitrack sync   # push your local AI usage data');
  log.info('  npx aitrack show   # render heatmap PNG');
}
