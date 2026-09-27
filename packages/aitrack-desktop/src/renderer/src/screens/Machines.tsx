import { useQuery } from '@tanstack/react-query';

import { when } from '../format';
import { ask } from '../types';

export function MachinesScreen() {
  const machines = useQuery({
    queryKey: ['machines'],
    queryFn: () => ask('machines:list'),
  });
  return (
    <section className="glass panel settle p-6">
      <h2 className="num text-[34px]">Machines</h2>
      <p className="mt-1 max-w-[56ch] text-[var(--muted)]">
        Other computers appear after they push to the data repo. This machine’s fresh logs are on
        the other screens.
      </p>
      {(machines.data ?? []).length === 0 ? (
        <p className="mt-4 text-[var(--muted)]">
          No synced machines yet. Connect a repo in Settings when you want one.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {(machines.data ?? []).map((machine) => (
            <li key={machine.id} className="flex justify-between">
              <span>
                {machine.id}
                <span className="ml-2 text-[13px] text-[var(--muted)]">{machine.timezone}</span>
              </span>
              <span className="text-[13px] text-[var(--muted)]">
                {machine.days} days, last updated {when(machine.lastUpdated)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
