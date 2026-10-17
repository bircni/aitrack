import { resolveModelCost } from '../pricing/resolve.js';
import { shiftDate } from './calendar.js';
import type { MachineFile, ProviderDay } from './types.js';

/**
 * The single byModel entry of a compacted day. Older aitrack versions require
 * byModel to sum to totals, so a lone entry mirroring them keeps those readers working.
 */
export const COMPACTED_MODEL = '(compacted)';

export function isCompactedDay(day: ProviderDay): boolean {
  const models = Object.keys(day.byModel);
  return models.length === 1 && models[0] === COMPACTED_MODEL;
}

function compactProviderDay(providerKey: string, date: string, day: ProviderDay): ProviderDay {
  if (isCompactedDay(day)) return day;
  const totals = { ...day.totals };
  if (totals.costUSD === undefined) {
    // Pricing the models now keeps the day's cost once they are gone.
    const costs = Object.entries(day.byModel).map(([model, counts]) =>
      resolveModelCost(providerKey, model, counts, date),
    );
    if (costs.length > 0 && costs.every((cost) => cost !== undefined)) {
      totals.costUSD = costs.reduce((sum, cost) => sum + cost, 0);
    } else if (totals.inputTokens + totals.outputTokens > 0) {
      totals.hasUnpricedTokens = true;
    }
  }
  return { byModel: { [COMPACTED_MODEL]: { ...totals } }, totals };
}

/** Days before `today` minus `afterDays` keep per-provider totals only; `today` is a local YYYY-MM-DD. */
export function compactDays(
  days: MachineFile['days'],
  afterDays: number,
  today: string,
): MachineFile['days'] {
  const cutoff = shiftDate(today, -afterDays);
  const compacted: MachineFile['days'] = {};
  for (const [date, providers] of Object.entries(days)) {
    compacted[date] =
      date >= cutoff
        ? providers
        : Object.fromEntries(
            Object.entries(providers).map(([providerKey, day]) => [
              providerKey,
              compactProviderDay(providerKey, date, day),
            ]),
          );
  }
  return compacted;
}
