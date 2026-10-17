import { describe, expect, it } from 'vitest';

import { dueAlerts, pruneFired } from '../alerts.js';
import { HOUR, NOW, sessionWindow, snapshot } from './quotaFixtures.js';

describe('alerts', () => {
  it('fires almost-out once per reset', () => {
    const quota = snapshot([sessionWindow(95, 2)]);
    const alerts = dueAlerts('Claude Code', quota, {}, NOW);
    expect(alerts).toMatchObject([
      { title: 'Claude Code session almost used up', body: '5% left until it resets.' },
    ]);
    const fired = Object.fromEntries(alerts.map((alert) => [alert.key, alert.resetsAt]));
    expect(dueAlerts('Claude Code', quota, fired, NOW)).toEqual([]);
    const drifted = {
      ...sessionWindow(95, 2),
      resetsAt: new Date(NOW + 3 * HOUR + 1000).toISOString(),
    };
    expect(dueAlerts('Claude Code', snapshot([drifted]), fired, NOW)).toEqual([]);
  });

  it('fires will-run-out from the pace and skips windows it cannot judge', () => {
    const alerts = dueAlerts(
      'Codex',
      snapshot([
        sessionWindow(80, 2.5),
        sessionWindow(10, 2.5),
        { ...sessionWindow(50, 1), resetsAt: undefined },
        { ...sessionWindow(99, 1), format: 'dollars' },
        { ...sessionWindow(95, 1), resetsAt: new Date(NOW - 1).toISOString() },
        { ...sessionWindow(95, 1), resetsAt: new Date(NOW).toISOString() },
        { ...sessionWindow(95, 1), resetsAt: 'invalid' },
      ]),
      {},
      NOW,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.title).toBe('Codex session on pace to run out');
    const fired = Object.fromEntries(alerts.map((alert) => [alert.key, alert.resetsAt]));
    expect(dueAlerts('Codex', snapshot([sessionWindow(80, 2.5)]), fired, NOW)).toEqual([]);
  });

  it('prunes alerts for windows that have reset', () => {
    expect(
      pruneFired(
        {
          old: new Date(NOW - 5 * 60_000 - 1).toISOString(),
          grace: new Date(NOW - 1).toISOString(),
        },
        NOW,
      ),
    ).toEqual({ grace: new Date(NOW - 1).toISOString() });
  });
});
