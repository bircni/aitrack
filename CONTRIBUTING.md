# Contributing

## Development setup

```sh
git clone https://github.com/bircni/aitrack.git
cd aitrack
pnpm install
pnpm run build
node dist/cli.js init
node dist/cli.js sync
node dist/cli.js show
```

Use `pnpm run dev -- init` (or `sync`, `show`) to run from TypeScript without building.

## Commit messages

Commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `build:`). The changelog and version bumps are generated from commit messages, so non-conforming commits will be invisible in release notes.

## Scripts

| Script                  | Description                             |
| ----------------------- | --------------------------------------- |
| `pnpm run validate`     | Lint, format check, typecheck, and test |
| `pnpm run test`         | Run tests                               |
| `pnpm run coverage`     | Run tests with coverage                 |
| `pnpm run build`        | Compile TypeScript to `dist/`           |
| `pnpm run lint`         | ESLint                                  |
| `pnpm run format`       | Prettier write                          |
| `pnpm run format:check` | Prettier check                          |

## Releasing

Releases are generated from Conventional Commits using [git-cliff](https://git-cliff.org/).

Prepare a release (version bump, changelog, tag, push) without publishing to npm:

```sh
pnpm run release -- patch
```

Dry-run the release flow:

```sh
pnpm run release:dry-run
```

Publish to npm when ready:

```sh
pnpm run release:publish
```

Use `minor`, `major`, `prepatch`, `preminor`, `premajor`, or `prerelease` instead of `patch` as needed. Use `none` to release the current version in `package.json` without bumping (intended for the very first release).

The release script runs `validate` and `build`, bumps `package.json`, updates `CHANGELOG.md`, commits, tags, and pushes. Add `--publish` to also run `pnpm publish --access public`.
