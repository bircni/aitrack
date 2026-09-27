# aitrack

Track and visualize your Claude Code, Codex & Cursor usage and cost — heatmaps, stats, and
multi-machine sync over a git repo you own.

```sh
npm install -g aitrack
aitrack init
aitrack sync
aitrack show
```

This package is the command line. The code behind it — readers, pricing, the data model,
storage and the renderers — is published separately as
[`aitrack-lib`](https://www.npmjs.com/package/aitrack-lib).

## Desktop app

The same machine can run the desktop app from
[GitHub Releases](https://github.com/bircni/aitrack/releases). It watches Claude Code, Codex, and
Cursor, links sessions to git commits, and shows speed, quality, and cost with the reason behind
each number. Builds are unsigned: macOS `dmg` and `zip` for arm64 and x64, Windows `nsis` and a
portable `exe` for x64 (the arm64 build is experimental), and Linux `AppImage` and `deb` for x64.
On macOS, open the app once from Finder and choose Open if Gatekeeper blocks it. On Windows,
choose More info, then Run anyway, if SmartScreen warns.

**[Full documentation, screenshots and configuration →](https://github.com/bircni/aitrack#readme)**

## License

[MIT](https://github.com/bircni/aitrack/blob/main/LICENSE)
