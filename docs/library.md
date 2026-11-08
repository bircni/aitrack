# aitrack-lib (discontinued)

[Back to the overview](../README.md)

`aitrack-lib` was the TypeScript library behind aitrack 4.x. In 5.0 the CLI and opentrack are Rust,
built on the `aitrack-core` crate in this repository, which is not published. The last library
release, 4.2.0, stays on npm and keeps working, but it gets no further updates.

To read aitrack data from your own tools, run the CLI with `--json` (see the [CLI guide](cli.md)),
or read the machine files in your data repo, whose format is described there.
