import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from 'recharts';

import { money, stackedCost } from './format';
import type { UsageDay } from './types';

export function StackedCost({ days, height = 220 }: { days: UsageDay[]; height?: number }) {
  const series = stackedCost(days, height > 160 ? 45 : 30);
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series}>
          <defs>
            <linearGradient id="fill-claude" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--claude)" stopOpacity={0.55} />
              <stop offset="100%" stopColor="var(--claude)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="fill-codex" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--codex)" stopOpacity={0.55} />
              <stop offset="100%" stopColor="var(--codex)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="fill-cursor" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--cursor)" stopOpacity={0.55} />
              <stop offset="100%" stopColor="var(--cursor)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            vertical={false}
            stroke="color-mix(in oklch, var(--text) 8%, transparent)"
          />
          <XAxis dataKey="day" hide />
          <Tooltip
            content={(props) => (
              <ChartTip active={props.active} label={props.label} payload={props.payload} />
            )}
          />
          <Area
            dataKey="claude_code"
            name="Claude Code"
            stackId="1"
            stroke="var(--claude)"
            fill="url(#fill-claude)"
          />
          <Area
            dataKey="codex"
            name="Codex"
            stackId="1"
            stroke="var(--codex)"
            fill="url(#fill-codex)"
          />
          <Area
            dataKey="cursor"
            name="Cursor"
            stackId="1"
            stroke="var(--cursor)"
            fill="url(#fill-cursor)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartTip({
  active,
  label,
  payload,
}: {
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{ dataKey?: unknown; name?: unknown; value?: unknown }>;
}) {
  if (!active || payload === undefined || payload.length === 0) return null;
  return (
    <div className="glass chip px-3 py-2 text-[13px] text-[var(--text)]">
      <p>{label}</p>
      <ul className="mt-1">
        {payload.map((item) => (
          <li key={String(item.dataKey)} style={{ color: tint(item.dataKey) }}>
            {typeof item.name === 'string' ? `${item.name} ` : ''}
            {money(typeof item.value === 'number' ? item.value : null)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function tint(key: unknown): string {
  switch (key) {
    case 'claude_code': {
      return 'var(--claude)';
    }
    case 'codex': {
      return 'var(--codex)';
    }
    case 'cursor': {
      return 'var(--cursor)';
    }
    default: {
      return 'var(--text)';
    }
  }
}
