import { StackedCost } from '../StackedCost';
import type { UsageDay } from '../types';

const SAMPLE: UsageDay[] = [
  row('2026-09-01', 'claude_code', 1.4),
  row('2026-09-01', 'codex', 0.6),
  row('2026-09-01', 'cursor', 0.3),
  row('2026-09-02', 'claude_code', 0.9),
  row('2026-09-02', 'codex', 0.5),
  row('2026-09-02', 'cursor', 0.2),
  row('2026-09-03', 'claude_code', 1.8),
  row('2026-09-03', 'codex', 0.4),
  row('2026-09-03', 'cursor', 0.7),
  row('2026-09-04', 'claude_code', 1.1),
  row('2026-09-04', 'codex', 0.8),
  row('2026-09-04', 'cursor', 0.25),
];

export function TokensScreen() {
  return (
    <div className="flex flex-col gap-3">
      <section className="glass pane settle p-6">
        <p className="num text-[52px] leading-none">52 glass</p>
        <p className="num mt-3 text-[34px]">34 numbers</p>
        <p className="mt-2 text-[24px]">24 section</p>
        <p className="mt-2 text-[18px]">18 title</p>
        <p className="mt-2 text-[15px]">15 body, the size you read.</p>
        <p className="mt-2 text-[13px] text-[var(--muted)]">13 supporting</p>
        <p className="mt-2 text-[12px] text-[var(--faint)]">12 caption</p>
      </section>
      <section className="glass panel p-5">
        <p>Chart</p>
        <p className="mt-1 text-[13px] text-[var(--muted)]">
          Stacked cost fades into the pane. Grid lines sit at 8% of the text color.
        </p>
        <div className="mt-3">
          <StackedCost days={SAMPLE} height={120} />
        </div>
      </section>
      <div className="grid grid-cols-3 gap-4">
        <section className="glass pane p-5">
          <p>Depth 0</p>
          <p className="mt-2 text-[13px] text-[var(--muted)]">Window pane, 22 radius, 40 blur.</p>
        </section>
        <section className="glass panel p-5">
          <p>Depth 1</p>
          <p className="mt-2 text-[13px] text-[var(--muted)]">Panel, 16 radius, 24 blur.</p>
        </section>
        <section className="glass chip p-5">
          <p>Depth 2</p>
          <p className="mt-2 text-[13px] text-[var(--muted)]">Floating, 10 radius, 32 blur.</p>
        </section>
      </div>
      <section className="glass panel p-5">
        <p className="text-[13px] text-[var(--muted)]">Provider tints, used for data only</p>
        <div className="mt-3 flex gap-6">
          <span style={{ color: 'var(--claude)' }}>Claude</span>
          <span style={{ color: 'var(--codex)' }}>Codex</span>
          <span style={{ color: 'var(--cursor)' }}>Cursor</span>
        </div>
      </section>
    </div>
  );
}

function row(day: string, provider: string, costUsd: number): UsageDay {
  return { day, provider, costUsd, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}
