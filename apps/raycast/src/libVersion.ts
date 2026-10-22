import libPackage from 'aitrack-lib/package.json';

// The bundle has no package.json beside it, so the lib's parse caches are keyed from here.
Object.assign(globalThis, { __AITRACK_LIB_VERSION__: libPackage.version });
