import { useQuery } from '@tanstack/react-query';

import { Explain } from '../Explain';
import { localDay, money, providerLabel, when } from '../format';
import { YearHeatmap } from '../Heatmap';
import { StackedCost } from '../StackedCost';
import { ask } from '../types';

export function Overview() {
  const usage = useQuery({ queryKey: ['cost'], queryFn: () => ask('cost:get') });
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => ask('sessions:list'),
  });
  const sync = useQuery({ queryKey: ['sync'], queryFn: () => ask('sync:status') });
  const commits = useQuery({
    queryKey: ['commits'],
    queryFn: () => ask('commits:list'),
  });
  const todayKey = localDay();
  const todayCost = (usage.data ?? [])
    .filter((day) => day.day === todayKey)
    .reduce((sum, day) => sum + day.costUsd, 0);
  const today = (sessions.data ?? [])
    .filter(
      (session) => session.startedAt !== null && localDay(new Date(session.startedAt)) === todayKey,
    )
    .slice(0, 6);
  const sessionCount = sessions.data?.length ?? 0;
  const linked = (commits.data ?? []).filter((commit) => commit.linked).length;
  const monthDays = (usage.data ?? []).filter((day) => day.day >= shiftDay(-30));

  return (
    <div className="flex flex-col gap-4">
      <section className="glass pane settle p-8">
        <div className="mb-6">
          <p className="text-[var(--muted)]">Today</p>
          <Explain
            figure={money(todayCost)}
            figureClassName="text-[52px] leading-none"
            rule="Today's estimated list price, summed from each provider's day totals on this machine."
          />
          <div className="mt-2 flex flex-wrap gap-x-4 text-[13px] text-[var(--muted)]">
            <Explain
              figure={countLabel(sessionCount, 'session', 'sessions')}
              rule="Sessions read from Claude Code, Codex, and Cursor on this machine. Up to six that started today are listed below."
            />
            <Explain
              figure={countLabel(linked, 'linked commit', 'linked commits')}
              rule="Commits that have a session link. A commit that later left the repository still counts when the link remains."
            />
            {sync.data?.cloned ? (
              <span className="ml-3">
                {sync.data.dirty ? 'Data repo has unpushed changes' : 'Data repo is current'}
              </span>
            ) : null}
          </div>
        </div>
        <YearHeatmap days={usage.data ?? []} />
        <p className="mt-3 max-w-[62ch] text-[13px] text-[var(--faint)]">
          Estimated list price, not your subscription bill. The year is anchored on a typical busy
          day, so one huge day does not flatten the rest.
        </p>
        {monthDays.length > 1 ? (
          <>
            <p className="mt-6 text-[13px] text-[var(--muted)]">Last 30 days</p>
            <StackedCost days={monthDays} height={120} />
          </>
        ) : (
          <p className="mt-6 text-[13px] text-[var(--muted)]">
            Last 30 days {money(monthDays.reduce((sum, day) => sum + day.costUsd, 0))}
          </p>
        )}
      </section>
      <section className="glass panel settle settle-late p-6">
        <h2 className="num text-[24px]">What happened today</h2>
        {today.length === 0 ? (
          <p className="mt-3 max-w-[48ch] text-[var(--muted)]">
            Nothing started today. Sessions from earlier days are on the Sessions screen.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-[oklch(1_0_0/0.08)]">
            {today.map((session) => (
              <li key={session.id} className="flex items-baseline justify-between gap-4 py-3">
                <div>
                  <p>{session.title ?? providerLabel(session.provider)}</p>
                  <p className="text-[13px] text-[var(--muted)]">
                    {providerLabel(session.provider)}
                    {session.branch ? ` on ${session.branch}` : ''}
                    <span className="ml-3">{when(session.startedAt)}</span>
                  </p>
                </div>
                {session.tokensKnown ? (
                  <Explain
                    figure={money(session.costUsd)}
                    figureClassName="text-[18px]"
                    rule="List price for this session's tokens, from its transcript."
                  />
                ) : (
                  <p className="text-[13px] text-[var(--faint)]">tokens daily</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

function shiftDay(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}
