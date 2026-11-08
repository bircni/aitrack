// Regenerate with `node --import tsx crates/core/tests/fixtures/js/generate-lib.ts` while the 4.x library is in the tree.
// Records what the TypeScript library returns, so the Rust port is tested against the real thing.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

import * as model from '../../../../../libs/aitrack-lib/src/data/modelId.js';
import { normalizeRemoteUrl } from '../../../../../libs/aitrack-lib/src/data/project.js';
import { machineIdValidationError } from '../../../../../libs/aitrack-lib/src/machineId.js';

const rows = (list: unknown[]) => `[\n${list.map((row) => JSON.stringify(row)).join(',\n')}\n]\n`;
const tables = new URL('../../../../../libs/aitrack-lib/src/pricing/tables/', import.meta.url);
const sources = new URL('../../../../../libs/aitrack-lib/src/', import.meta.url);

const ids = new Set<string>();
const collect = (value: unknown, key = ''): void => {
  if (
    typeof value === 'string' &&
    /^(claude|gpt|o\d|gemini|grok|composer|kimi|deepseek|cursor)/iu.test(value)
  )
    ids.add(value);
  if (Array.isArray(value)) value.forEach((item) => collect(item));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/^(claude|gpt|o\d|gemini|grok|composer|kimi|deepseek|cursor)/iu.test(k)) ids.add(k);
      collect(v, k);
    }
  }
  void key;
};
for (const file of readdirSync(tables))
  collect(JSON.parse(readFileSync(new URL(file, tables), 'utf8')));
const walk = (dir: URL): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir));
    else if (entry.name.endsWith('.ts')) {
      const text = readFileSync(new URL(entry.name, dir), 'utf8');
      for (const match of text.matchAll(
        /'((?:claude|gpt|o\d|gemini|grok|composer|kimi|deepseek)[A-Za-z0-9.\-]*)'/gu,
      ))
        ids.add(match[1]);
    }
  }
};
walk(sources);
const bases = [...ids];
const suffixes = [
  '',
  '-latest',
  '-20250514',
  '-thinking',
  '-high',
  '-thinking-high',
  '-xhigh',
  '-max',
  '-codex-max',
  '-medium-thinking',
  '-low-fast',
  '-fast',
  '-long-context',
  '-thinking-extra-high-fast',
  '-none',
  '-minimal',
  '-ultra',
  '-max-max',
];
const models = new Set<string>(bases);
for (const base of bases.slice(0, 60))
  for (const suffix of suffixes) models.add(`${base}${suffix}`);
for (const extra of [
  'claude-4.6-opus',
  'claude-4-sonnet-thinking',
  'CLAUDE-OPUS-4-1',
  'claude-3.5-haiku-20241022',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-max-high',
  'x-max',
  'max',
  '-max',
  'claude-opus-4-1.2.3',
  'claude-10-opus',
  'claude-4-7-fable-fast',
])
  models.add(extra);

const modelRows = [...models].map((id) => [
  id,
  model.stripClaudeTierSuffix(id),
  model.stripModelAliasSuffix(id),
  model.stripModelVersionSuffixes(id),
  model.stripModelEffortSuffix(id),
  model.modelEffortLabel(id) ?? null,
  model.canonicalModelId(id),
  model.canonicalizeClaudeModelId(id),
]);
writeFileSync(new URL('model-ids.json', import.meta.url), rows(modelRows));

const urls = [
  'git@github.com:Owner/Repo.git',
  'git@github.com:owner/repo',
  'git@host:/srv/data.git',
  'git@C:/srv/data',
  'host:owner/repo',
  'h:owner/repo',
  'github.com:owner/repo/',
  'git@example.com:me/data.git\n',
  '  git@github.com:a/b.git  ',
  'git@github.com:~/a/b.git',
  'https://github.com/me/Data',
  'https://GitHub.COM/me/data.git',
  'https://***@github.com/me/d.git',
  'https://ghp_token@github.com/me/d.git',
  'https://gitea.local:443/me/data',
  'http://localhost:3000/me/data',
  'ssh://git@github.com:22/owner/repo.git',
  'ssh://git@github.com/owner/repo.git/',
  'git://github.com/owner/repo',
  'git+ssh://git@github.com/owner/repo.git',
  'file:///srv/owner/repo.git',
  'file:///srv/data.git',
  'file:',
  'https://github.com/owner',
  'https://github.com/',
  'https://github.com',
  'https://github.com/a%20b/repo',
  'https://github.com/owner/re%2Fpo',
  'https://github.com/owner/%E2%82%AC',
  'https://github.com/owner/%ZZ',
  'https://github.com/owner/repo?x=1#y',
  'https://github.com/./repo',
  'https://github.com/owner/..',
  'https://github.com//owner//repo//',
  'https:\\\\github.com\\owner\\repo',
  'HTTPS://github.com/Owner/Repo',
  '/srv/owner/repo',
  'C:\\srv\\owner\\repo',
  'owner/repo',
  '',
  ' ',
  'not a url',
  'https://user:pass@host/owner/repo.git.git',
  'https://github.com/owner/repo%20name',
  'git@github.com:owner/repo name.git',
  'https://github.com/ÖWNER/Repo',
];
writeFileSync(
  new URL('remote-urls.json', import.meta.url),
  rows(urls.map((url) => [url, normalizeRemoteUrl(url)])),
);

const machineIds = [
  'laptop',
  ' laptop ',
  '',
  '   ',
  '.',
  '..',
  'a.',
  'con',
  'CON',
  'con.txt',
  'com1',
  'com0',
  'lpt9.x',
  'console',
  'a/b',
  'a\\b',
  'a:b',
  'a*b',
  'a?b',
  'a"b',
  'a<b',
  'a>b',
  'a|b',
  'tab\there',
  'nul\u0000',
  'été',
  '🙂',
  'x'.repeat(250),
  'x'.repeat(251),
  'é'.repeat(125),
  '\uFEFFlaptop',
  'laptop\u0085',
  'laptop\u00a0',
];
writeFileSync(
  new URL('machine-ids.json', import.meta.url),
  rows(machineIds.map((id) => [id, machineIdValidationError(id)])),
);

const { redactUrl, sameRemote } = await import('../../../../../libs/aitrack-lib/src/git/remote.js');
const remotes = [
  'git@github.com:me/data.git', 'git@github.com:me/data', 'git@github.com:Me/Data.git', 'ssh://git@github.com/me/data.git',
  'ssh://git@github.com:22/me/data.git', 'ssh://git@github.com:2222/me/data.git', 'https://github.com/me/data.git',
  'https://github.com/me/data', 'https://GitHub.com/me/data/', 'https://ghp_token@github.com/me/data.git', 'https://user:pass@github.com/me/data',
  'https://github.com:443/me/data', 'https://github.com:8443/me/data', 'http://github.com/me/data', 'git://github.com/me/data',
  'git+ssh://git@github.com/me/data.git', 'file:///srv/data.git', 'file:///srv/data', '/srv/data.git', '/srv/data', 'C:/srv/data',
  'C:\\srv\\data', 'git@[::1]:me/data.git', 'ssh://user:secret@host/x', 'SSH://git@host/x', 'https://@host/x', 'ftp://u:p@host/x',
  'not a url', '', 'git@gitlab.com:me/data.git', 'https://gitea.local/me/data', 'https://gitea.local:443/me/data',
];
const remoteRows = remotes.map((url) => [url, redactUrl(url), remotes.filter((other) => sameRemote(url, other))]);
writeFileSync(new URL('remotes.json', import.meta.url), rows(remoteRows));
