import { readFileSync } from 'node:fs';

/** `<platform>-<arch>` to the npm package holding that binary, as the launcher resolves it. */
export const NPM_TARGETS: Record<string, string> = JSON.parse(
  readFileSync(new URL('../npm/aitrack/targets.json', import.meta.url), 'utf8'),
) as Record<string, string>;

/** The release asset and the file inside the platform package. */
export function binaryName(target: string): { asset: string; file: string } {
  const exe = target.startsWith('win32-') ? '.exe' : '';
  return { asset: `aitrack-${target}${exe}`, file: `aitrack${exe}` };
}

/** `npm pack`'s file name: a scope's `@` dropped and its `/` turned into `-`. */
export function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`;
}

/** Platform packages first: the launcher pins their exact version. */
export function publishOrder(): string[] {
  return [...Object.values(NPM_TARGETS), 'aitrack'];
}
