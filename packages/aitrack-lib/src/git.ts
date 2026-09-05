/**
 * The data repo, as one entry point.
 *
 * The implementation lives in `git/` (running git, repo lifecycle) and `store/`
 * (the machine JSON files, and renaming them). This barrel is what the commands
 * and the test mocks import, so the split did not ripple through them.
 */
export { LOCAL_REPO } from './paths.js';
export {
  cloneRepo,
  commitAndPush,
  commitDataChanges,
  hasMachineDataChanges,
  hasUnpushedCommits,
  isCloned,
  pull,
  pushPendingCommits,
  removeLocalClone,
} from './git/repo.js';
export {
  adoptPendingDataFiles,
  listDataFiles,
  listPendingDataFiles,
  readDataFile,
  removePendingMachineFile,
  writePendingMachineFile,
} from './store/machineFiles.js';
export { migrateMachineDataFiles } from './store/migrate.js';
