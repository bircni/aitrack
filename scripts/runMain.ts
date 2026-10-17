import { pathToFileURL } from 'node:url';

/** Runs `main` only when `moduleUrl` is the script node was started with; a failure prints its message and exits 1. */
export function runMain(moduleUrl: string, main: () => void): void {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined || moduleUrl !== pathToFileURL(entryPoint).href) return;
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
