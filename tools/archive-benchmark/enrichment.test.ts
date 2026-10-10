import { describe, expect, it } from 'vitest';
import { parseEnrichmentOptions } from './enrichment';

describe('enrichment benchmark admission', () => {
  it('requires repeated bounded synthetic trials and an output destination', () => {
    expect(parseEnrichmentOptions(['--output', '/tmp/synthetic.json'])).toEqual({
      count: 120,
      runs: 3,
      output: '/tmp/synthetic.json',
    });
    expect(
      parseEnrichmentOptions(['--count', '1200', '--runs', '5', '--output', '/tmp/synthetic.json']),
    ).toMatchObject({ count: 1200, runs: 5 });
    for (const args of [
      [],
      ['--runs', '2'],
      ['--count', '0'],
      ['--count', '10001'],
      ['--runs', 'NaN'],
    ])
      expect(() => parseEnrichmentOptions(args)).toThrow();
  });
  it('rejects external database URIs and duplicate or incomplete arguments', () => {
    for (const args of [
      ['--uri', 'mongodb://remote'],
      ['--output'],
      ['--count', '1', '--count', '2'],
      ['--unknown', 'value'],
    ])
      expect(() => parseEnrichmentOptions(args)).toThrow('Expected unique');
  });
});
