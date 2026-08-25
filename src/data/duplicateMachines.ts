import type { MachineFile } from './types.js';

export interface DuplicateMachineDays {
  /** Dates recorded identically under more than one machine. */
  days: string[];
  /** The machines involved, sorted. */
  machines: string[];
}

/**
 * Find days that appear identically under more than one machine.
 *
 * The same machine synced under two ids (a hostname that changed with the
 * network, say) leaves two data files holding byte-identical days, and every
 * all-time total then counts that usage twice. Identical payloads are the
 * signal: two machines genuinely used on the same day produce different
 * numbers.
 *
 * Pure so it can be tested directly — this was ~40 lines inside the doctor
 * command, wedged between subprocess calls and chalk formatting.
 */
export function findDuplicateMachineDays(machines: MachineFile[]): DuplicateMachineDays {
  const byDay = new Map<string, Map<string, string[]>>();
  for (const machine of machines) {
    for (const [date, providers] of Object.entries(machine.days)) {
      const payloads = byDay.get(date) ?? new Map<string, string[]>();
      const payload = JSON.stringify(providers);
      payloads.set(payload, [...(payloads.get(payload) ?? []), machine.hostname]);
      byDay.set(date, payloads);
    }
  }

  const collidingDays = new Set<string>();
  const collidingMachines = new Set<string>();
  for (const [date, payloads] of byDay) {
    for (const hostnames of payloads.values()) {
      if (hostnames.length < 2) continue;
      collidingDays.add(date);
      for (const host of hostnames) collidingMachines.add(host);
    }
  }

  return {
    days: [...collidingDays].sort((a, b) => a.localeCompare(b)),
    machines: [...collidingMachines].sort((a, b) => a.localeCompare(b)),
  };
}
