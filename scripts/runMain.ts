import { pathToFileURL } from 'node:url';

/**
 * Runs `main` only when `moduleUrl` is the script node was started with. A returned number
 * becomes the exit code; a failure prints its message and exits 1.
 */
export function runMain(moduleUrl: string, main: () => unknown): void {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined || moduleUrl !== pathToFileURL(entryPoint).href) return;
  void (async () => {
    try {
      const code = await main();
      if (typeof code === 'number') process.exit(code);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  })();
}
