import { describe, expect, it } from 'vitest';

import {
  catalogFromCompact,
  catalogFromLiteLLM,
  findCatalogRates,
} from '../../libs/aitrack-lib/src/pricing/codecs.js';
import { catalogIo, compareAgainstCatalog, tallyFindings } from '../update-pricing.js';

describe('pricing checker against catalogs', () => {
  const primary = catalogFromLiteLLM({
    'anthropic/claude-sonnet-4-6': {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
      cache_creation_input_token_cost: 3.75e-6,
      cache_read_input_token_cost: 3e-7,
    },
    'openai/gpt-5.6-sol': {
      input_cost_per_token: 4e-6,
      output_cost_per_token: 20e-6,
    },
  });
  const secondary = catalogFromCompact({
    retrievedAt: '2026-10-02T00:00:00Z',
    models: {
      'claude-sonnet-4-6': { i: 3, o: 15, cw: 3.75, cr: 0.3 },
      'composer-1': { i: 1.25, o: 10, cw: 1.25, cr: 0.125 },
    },
  });
  const catalogs = { primary, secondary };

  it('matches exact Claude/Codex rates', () => {
    const findings = compareAgainstCatalog({
      label: 'Claude',
      table: {
        'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
      },
      knownIds: ['claude-sonnet-4-6'],
      sourceFile: 'claude.json',
      providers: ['anthropic'],
      primary,
      secondary,
    });
    expect(findings).toEqual([{ kind: 'ok', modelId: 'claude-sonnet-4-6', summary: '$3/$15' }]);
  });

  it('flags drift when catalog IO differs', () => {
    const findings = compareAgainstCatalog({
      label: 'Codex',
      table: {
        'gpt-5.6-sol': { inputPerMillion: 5, outputPerMillion: 30 },
      },
      knownIds: ['gpt-5.6-sol'],
      sourceFile: 'codex.json',
      providers: ['openai'],
      primary,
      secondary,
    });
    expect(findings[0]).toMatchObject({
      kind: 'drift',
      isInOk: false,
      isOutOk: false,
      saw: [4, 20],
    });
  });

  it('marks models missing from catalogs as unverified', () => {
    const findings = compareAgainstCatalog({
      label: 'Cursor',
      table: {
        'composer-2.5': { inputPerMillion: 0.5, outputPerMillion: 2.5 },
      },
      knownIds: ['composer-2.5'],
      sourceFile: 'cursor.json',
      providers: ['cursor'],
      primary,
      secondary,
    });
    expect(findings[0]?.kind).toBe('unverified');
  });

  it('tallies finding kinds', () => {
    expect(
      tallyFindings([
        { kind: 'ok', modelId: 'a', summary: '$1/$2' },
        { kind: 'drift', modelId: 'b', summary: '$1/$2', isInOk: false, isOutOk: true, saw: [3] },
        { kind: 'unverified', modelId: 'c', summary: '$1/$2', where: 'x' },
        { kind: 'missing', modelId: 'd' },
      ]),
    ).toEqual({ drift: 1, unverified: 1, missing: 1 });
  });

  it('resolves provider-prefixed catalog keys', () => {
    expect(catalogIo(catalogs, 'claude-sonnet-4-6', ['anthropic'])?.inputPerMillion).toBe(3);
    expect(findCatalogRates(primary, 'gpt-5.6-sol', ['openai'])?.rates.outputPerMillion).toBe(20);
  });
});
