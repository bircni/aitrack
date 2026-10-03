import { readFileSync } from 'node:fs';

const libPackage = JSON.parse(
  readFileSync(new URL('../../libs/aitrack-lib/package.json', import.meta.url), 'utf8'),
) as { version: string };

export default {
  define: {
    'import.meta.dirname': '__dirname',
    // A SEA has no package.json beside it, so the parse cache key is baked in.
    __AITRACK_LIB_VERSION__: JSON.stringify(libPackage.version),
  },
};
