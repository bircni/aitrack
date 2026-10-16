import type { MachineFile } from './types.js';

export interface DuplicateMachineDays {
  /** Dates recorded identically under more than one machine. */
  days: string[];
  /** The machines involved, sorted. */
  machines: string[];
}

/** One machine synced under two ids leaves identical days; distinct machines never match exactly. */
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
    days: [...collidingDays].toSorted((a, b) => a.localeCompare(b)),
    machines: [...collidingMachines].toSorted((a, b) => a.localeCompare(b)),
  };
}
