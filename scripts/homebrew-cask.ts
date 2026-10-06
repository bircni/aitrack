#!/usr/bin/env tsx
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The cask published to bircni/homebrew-tap as Casks/opentrack.rb. */
function renderCask(version: string, sha256: string): string {
  return `cask "opentrack" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/bircni/aitrack/releases/download/v#{version}/opentrack_#{version}_aarch64.dmg"
  name "opentrack"
  desc "Menu bar dashboard for Claude Code, Codex and Cursor limits and spend"
  homepage "https://github.com/bircni/aitrack/blob/main/docs/opentrack.md"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  app "opentrack.app"

  # Ad hoc signed and not notarized, so Gatekeeper would refuse the quarantined copy.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/opentrack.app"]
  end

  zap trash: [
    "~/Library/Application Support/dev.bircni.opentrack",
    "~/Library/Caches/dev.bircni.opentrack",
    "~/Library/WebKit/dev.bircni.opentrack",
  ]
end
`;
}

function main(): void {
  const [tag, dmgPath] = process.argv.slice(2);
  if (!tag || !dmgPath) throw new Error('Usage: tsx scripts/homebrew-cask.ts <tag> <dmg-path>');
  const sha256 = createHash('sha256').update(readFileSync(dmgPath)).digest('hex');
  process.stdout.write(renderCask(tag.replace(/^v/u, ''), sha256));
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
