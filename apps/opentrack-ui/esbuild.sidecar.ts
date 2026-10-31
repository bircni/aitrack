import { readFileSync } from 'node:fs';

const libPackage = JSON.parse(
  readFileSync(new URL('../../libs/aitrack-lib/package.json', import.meta.url), 'utf8'),
) as { version: string };

export default {
  define: {
    'import.meta.dirname': '__dirname',
    'import.meta.url': 'undefined', // No worker file beside a bundle, so the reader scans in-thread.
    // A SEA has no package.json beside it, so the parse cache key is baked in.
    __AITRACK_LIB_VERSION__: JSON.stringify(libPackage.version),
  },
};
