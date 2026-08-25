import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import prompts from 'prompts';

import { loadConfig, resolveMachineId, saveConfig } from '../config.js';
import {
  adoptPendingDataFiles,
  cloneRepo,
  isCloned,
  LOCAL_REPO,
  migrateMachineDataFiles,
  removeLocalClone,
} from '../git.js';
import { machineIdValidationError, normalizeMachineId } from '../machineId.js';
import { log } from '../output.js';

async function promptOverwrite(): Promise<boolean | undefined> {
  const answers = await prompts<'overwrite'>({
    type: 'confirm',
    name: 'overwrite',
    message: 'Config already exists. Overwrite?',
    initial: false,
  });
  const overwrite: unknown = answers.overwrite;
  return typeof overwrite === 'boolean' ? overwrite : undefined;
}

async function promptReclone(): Promise<boolean | undefined> {
  const answers = await prompts<'reclone'>({
    type: 'confirm',
    name: 'reclone',
    message: 'Repo URL changed. Remove local clone and re-clone from the new URL?',
    initial: false,
  });
  const reclone: unknown = answers.reclone;
  return typeof reclone === 'boolean' ? reclone : undefined;
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

export async function initCommand(): Promise<void> {
  let existing = null;
  try {
    existing = loadConfig();
  } catch {
    /* not yet configured */
  }

  if (existing) {
    log.info(`Current config: repo=${existing.repoUrl}`);
    const overwrite = await promptOverwrite();
    if (!overwrite) {
      log.info('Aborted.');
      return;
    }
  }
  const previousMachineId = resolveMachineId(existing ?? { repoUrl: '' });

  log.info('First, create an empty GitHub repository (or any git remote) for storing data.');
  log.info('Example: https://github.com/new — name it something like "aitrack-data".');
  log.info('');

  const repoUrl = await promptRepoUrl();
  if (!repoUrl) {
    log.info('Aborted.');
    return;
  }

  const isUrlChanged = existing !== null && existing.repoUrl !== repoUrl;
  const wasCloned = isCloned();

  if (wasCloned && isUrlChanged) {
    const reclone = await promptReclone();
    if (!reclone) {
      log.info('Aborted.');
      return;
    }
    log.info(`Removing existing clone at ${LOCAL_REPO}...`);
    removeLocalClone();
  }

  // Every path below this point ends with a clone present: either one was
  // already there and is being kept, or one is made here.
  if (wasCloned && !isUrlChanged) {
    log.info(`Repo already cloned at ${LOCAL_REPO}. Skipping clone.`);
  } else {
    log.info(`Cloning ${repoUrl} into ${LOCAL_REPO}...`);
    mkdirSync(dirname(LOCAL_REPO), { recursive: true });
    cloneRepo(repoUrl);
  }

  const machineId = await promptMachineId(existing?.machineId ?? hostname());
  if (!machineId) {
    log.info('Aborted.');
    return;
  }

  // Adopt pre-clone staging under the identity that created it. Once a clone
  // already exists, pending data may duplicate its synced current-machine file.
  let adopted = 0;
  if (existing === null || !wasCloned) {
    adopted = adoptPendingDataFiles(join(LOCAL_REPO, 'data'));
  }
  migrateMachineDataFiles(previousMachineId, machineId);

  saveConfig({ repoUrl, machineId });
  if (adopted > 0) {
    log.info(`Adopted ${String(adopted)} pending data file(s) into the repo.`);
  }

  log.info('');
  log.info('Done! Next steps:');
  log.info('  npx aitrack sync   # push your local AI usage data');
  log.info('  npx aitrack show   # render heatmap PNG');
}
