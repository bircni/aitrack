#!/usr/bin/env tsx

import { runMain } from './runMain.ts';
import { sha256File, versionFromTag } from './util.ts';

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
  const sha256 = sha256File(dmgPath);
  process.stdout.write(renderCask(versionFromTag(tag), sha256));
}

runMain(import.meta.url, main);
