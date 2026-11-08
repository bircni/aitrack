// Regenerate with `node crates/core/tests/fixtures/js/generate.mjs`; the Rust `js` module is tested against Node's own output.
import { writeFileSync } from 'node:fs';

let seed = 0x2545f491;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};
const rows = (list) => `[\n${list.map((row) => JSON.stringify(row)).join(',\n')}\n]\n`;
const bits = (x) => new BigUint64Array(new Float64Array([x]).buffer)[0].toString(16).padStart(16, '0');

const numbers = [0, -0, 1, -1, 0.1, 0.2, 0.1 + 0.2, 1e21, 1e-7, 1e-6, 9.999999999999999e20, 123456789012345680000];
numbers.push(Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON, 2 ** 53, 2 ** 53 + 2, 45000, 0.0000045, 1.25, 1.35);
for (let exponent = -12; exponent <= 25; exponent++) {
  for (let i = 0; i < 12; i++) numbers.push((random() - 0.2) * 10 ** exponent);
}
// Costs as the readers compute them: tokens times a per-million rate.
for (let i = 0; i < 300; i++) {
  const tokens = Math.floor(random() * 10 ** Math.floor(random() * 8));
  const rate = [0.075, 0.1, 0.15, 0.3, 1.25, 2.5, 3, 3.75, 10, 15, 75][Math.floor(random() * 11)];
  numbers.push((tokens * rate) / 1e6);
}
writeFileSync(
  new URL('numbers.json', import.meta.url),
  rows(numbers.map((x) => [bits(x), JSON.stringify(x)])),
);

const alphabet = ['a', 'b', 'c', 'z', 'A', 'B', 'Z', '0', '1', '2', '9', '-', '_', '.', '/', ':', ' ', '@', '\0', '~', 'é'];
const word = () => Array.from({ length: 1 + Math.floor(random() * 6) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
const pairs = [];
for (let i = 0; i < 3000; i++) {
  const a = word();
  const roll = random();
  // Near misses matter most: case flips, an inserted character, a shared prefix.
  const b = roll < 0.25 ? a.toUpperCase() : roll < 0.5 ? a + word() : roll < 0.65 ? word() + a : word();
  pairs.push([a, b, Math.sign(a.localeCompare(b))]);
}
for (const [a, b] of [['claude_code', 'codex'], ['foo-bar/x', 'foo_bar/x'], ['foo2/x', 'foo-bar/x'], ['claude_code\0opus', 'claude_code\0opus-4']]) {
  pairs.push([a, b, Math.sign(a.localeCompare(b))]);
}
writeFileSync(new URL('collation.json', import.meta.url), rows(pairs));

// `new Date(text)` in each zone: epoch ms and the local calendar day, null when JS rejects the text.
const { execFileSync } = await import('node:child_process');
const texts = [
  '2026-03-08T10:00:00Z', '2026-03-08T10:00:00.123+05:30', '2026-03-08T23:59:59.999-11:00', '2024-12-31T23:59:59.999Z',
  '2026-03-08T10:00:00.123456789Z', '2026-03-08', '2026-03-08T23:30:00', '2026-03-08T23:30', '2026-03-08 23:30:00',
  '2026-03-08T02:30:00', '2026-11-01T01:30:00', '2026-02-30', '2026-02-30T10:00:00Z', 'garbage', '',
];
const timestamps = [];
for (const zone of ['Pacific/Kiritimati', 'UTC', 'Pacific/Midway', 'Europe/Berlin', 'America/New_York']) {
  const script = `const d=(t)=>{const x=new Date(t);if(Number.isNaN(x.getTime()))return[null,null];const p=(n)=>String(n).padStart(2,'0');return[x.getTime(),\`\${x.getFullYear()}-\${p(x.getMonth()+1)}-\${p(x.getDate())}\`]};console.log(JSON.stringify(${JSON.stringify(texts)}.map(d)))`;
  const results = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { TZ: zone } }).toString());
  texts.forEach((text, i) => timestamps.push([text, zone, ...results[i]]));
}
writeFileSync(new URL('timestamps.json', import.meta.url), rows(timestamps));
