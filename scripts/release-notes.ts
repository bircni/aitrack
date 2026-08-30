#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A section ends at the next release heading or at any git-cliff trailer that
// follows the final section: reference-style link definitions ("[v1.0.0]: ...")
// or an HTML comment footer.
function isSectionBoundary(line: string): boolean {
  return line.startsWith('## ') || /^\[[^\]]+\]:\s/u.test(line) || line.startsWith('<!--');
}

function extractReleaseNotes(changelog: string, tag: string): string {
  const lines = changelog.split(/\r?\n/u);
  // Match the release heading tolerantly: the closing "]" fully delimits the
  // tag, so anything after it (" - date", a compare link, trailing whitespace)
  // still counts as this tag's section.
  const heading = `## [${tag}]`;
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) {
    throw new Error(`Could not find a ${tag} section in the changelog.`);
  }

  const nextBoundary = lines.findIndex((line, index) => index > start && isSectionBoundary(line));
  const end = nextBoundary === -1 ? lines.length : nextBoundary;
  const notes = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  if (notes === '') {
    throw new Error(`The ${tag} changelog section is empty.`);
  }
  return `${notes}\n`;
}

function main(): void {
  const [tag, changelogPath = 'CHANGELOG.md'] = process.argv.slice(2);
  if (tag === undefined || tag === '') {
    throw new Error('Usage: tsx scripts/release-notes.ts <tag> [changelog-path]');
  }
  process.stdout.write(extractReleaseNotes(readFileSync(changelogPath, 'utf8'), tag));
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
