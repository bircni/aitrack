import prompts from 'prompts';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { hostname } from 'os';
import { loadConfig, saveConfig } from './config.js';
import { adoptPendingDataFiles, isCloned, cloneRepo, removeLocalClone, LOCAL_REPO } from './git.js';

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
    validate: (v: string) => v.trim().length > 0 || 'Name is required',
  });
  const machineId: unknown = answers.machineId;
  return typeof machineId === 'string' ? machineId.trim() : undefined;
}

export async function initCommand(): Promise<void> {
  let existing = null;
  try {
    existing = loadConfig();
  } catch {
    /* not yet configured */
  }

  if (existing) {
    console.log(`Current config: repo=${existing.repoUrl}`);
    const overwrite = await promptOverwrite();
    if (!overwrite) {
      console.log('Aborted.');
      return;
    }
  }

  console.log('First, create an empty GitHub repository (or any git remote) for storing data.');
  console.log('Example: https://github.com/new — name it something like "aitrack-data".');
  console.log('');

  const repoUrl = await promptRepoUrl();
  if (!repoUrl) {
    console.log('Aborted.');
    return;
  }

  const urlChanged = existing !== null && existing.repoUrl !== repoUrl;

  if (isCloned() && urlChanged) {
    const reclone = await promptReclone();
    if (!reclone) {
      console.log('Aborted.');
      return;
    }
    console.log(`Removing existing clone at ${LOCAL_REPO}...`);
    removeLocalClone();
    console.log(`Cloning ${repoUrl} into ${LOCAL_REPO}...`);
    mkdirSync(dirname(LOCAL_REPO), { recursive: true });
    cloneRepo(repoUrl);
  } else if (isCloned()) {
    console.log(`Repo already cloned at ${LOCAL_REPO}. Skipping clone.`);
  } else {
    console.log(`Cloning ${repoUrl} into ${LOCAL_REPO}...`);
    mkdirSync(dirname(LOCAL_REPO), { recursive: true });
    cloneRepo(repoUrl);
  }

  const machineId = await promptMachineId(existing?.machineId ?? hostname());
  if (!machineId) {
    console.log('Aborted.');
    return;
  }

  saveConfig({ repoUrl, machineId });

  if (isCloned()) {
    const adopted = adoptPendingDataFiles(join(LOCAL_REPO, 'data'));
    if (adopted > 0) {
      console.log(`Adopted ${adopted} pending data file(s) into the repo.`);
    }
  }

  console.log('');
  console.log('Done! Next steps:');
  console.log('  npx aitrack sync   # push your local AI usage data');
  console.log('  npx aitrack show   # render heatmap PNG');
}
