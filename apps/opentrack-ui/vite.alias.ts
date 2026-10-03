import { fileURLToPath } from 'node:url';

/** `aitrack-lib/x/y` → the lib's TypeScript source, so it is bundled rather than installed. */
export const aitrackLibAlias = [
  {
    find: /^aitrack-lib\/(.*)$/u,
    replacement: `${fileURLToPath(new URL('../../libs/aitrack-lib/src/', import.meta.url))}$1.ts`,
  },
];
