/**
 * Keeps the Windows caller script and nijika's alert API in step without
 * running PowerShell: the script's argument table must cover the request
 * schema exactly, the documented example must map to an accepted body that
 * the server treats as a test, the URL comes only from the operator's config
 * file, and both files keep the encodings Windows needs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ARRIVAL_WINDOW_SECONDS } from '../../src/plugins/earthquake/internal/alert-server';
import {
  APP_TEST_ALERT,
  EarthquakeAlertSchema,
  INTENSITIES,
  isAppTestAlert,
} from '../../src/plugins/earthquake/internal/alert-request';

const DIR = path.resolve(__dirname, 'windows');
const scriptBytes = readFileSync(path.join(DIR, 'earthquake-alert.ps1'));
const script = scriptBytes.toString('utf8');
const readme = readFileSync(path.join(DIR, 'README.md'), 'utf8');

type Kind = 'Number' | 'Integer' | 'Intensity';

/** The `$ArgumentMap` rows: `'name' = @{ Field = 'field'; Kind = 'Kind' }`. */
const argumentMap = new Map(
  [
    ...script.matchAll(
      /^\s*'([a-z-]+)'\s*=\s*@\{ Field = '(\w+)'; Kind = '(Number|Integer|Intensity)' \}$/gm,
    ),
  ].map((match) => [match[1]!, { field: match[2]!, kind: match[3] as Kind }]),
);

/** Mirror of the script's conversion: numbers parse, integers round. */
const toBody = (args: readonly string[]): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    const spec = match === null ? undefined : argumentMap.get(match[1]!);
    if (match === null || spec === undefined) throw new Error(`unmapped argument ${arg}`);
    const value = match[2]!;
    body[spec.field] =
      spec.kind === 'Intensity'
        ? value
        : spec.kind === 'Integer'
          ? Math.round(Number(value))
          : Number(value);
  }
  return body;
};

const documentedExample = (): string[] => {
  const line = readme.split('\n').find((text) => text.startsWith('--epicenter-lat='));
  if (line === undefined) throw new Error('example arguments not found in README.md');
  return line.trim().split(/\s+/);
};

describe('earthquake alert caller contract', () => {
  it('maps one argument to every request field', () => {
    expect(argumentMap.size).toBe(8);
    expect([...argumentMap.values()].map((spec) => spec.field).sort()).toEqual(
      Object.keys(EarthquakeAlertSchema.shape).sort(),
    );
  });

  it('accepts the intensities the server accepts, and no others', () => {
    const list = /\$Intensities = @\(([^)]*)\)/.exec(script)?.[1];
    expect(list?.split(',').map((item) => item.trim().replace(/'/g, ''))).toEqual([...INTENSITIES]);
  });

  it('turns the documented test-button example into an accepted body', () => {
    const parsed = EarthquakeAlertSchema.safeParse(toBody(documentedExample()));

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      epicenterLat: 23.85,
      epicenterLon: 120.82,
      depthKm: 10,
      magnitude: 7.3,
      maxIntensity: '7',
      localIntensity: '5+',
      arrivalTime: 1_717_142_400,
      remainingSeconds: 20,
    });
  });

  it('agrees with the server on what counts as a test', () => {
    expect(script).toContain(`$TestAgeSeconds = ${ARRIVAL_WINDOW_SECONDS}`);
    const table = /\$AppTestAlert = @\{([^}]*)\}/.exec(script)?.[1] ?? '';
    const entries = Object.fromEntries(
      table
        .split(/[;\n]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.split('=').map((part) => part.trim().replace(/'/g, ''))),
    );
    expect(entries).toEqual(
      Object.fromEntries(
        Object.entries(APP_TEST_ALERT).map(([key, value]) => [key, String(value)]),
      ),
    );
  });

  it('recognises the documented test-button example at any arrival time', () => {
    const body = EarthquakeAlertSchema.parse(toBody(documentedExample()));

    expect(isAppTestAlert(body)).toBe(true);
    expect(isAppTestAlert({ ...body, arrivalTime: Math.floor(Date.now() / 1000) + 20 })).toBe(true);
    expect(isAppTestAlert({ ...body, magnitude: 7.2 })).toBe(false);
  });

  it('reads the URL only from its config file, never from a built-in host', () => {
    expect(script).not.toMatch(/https:\/\/[a-z0-9-]+\./i);
    expect(script).toContain('throw "config file not found: $ConfigFile"');
    expect(readme).toContain('{ "url": "https://<server>.<tailnet>.ts.net/earthquake/alerts" }');
  });

  it('keeps the encodings Windows PowerShell 5.1 and cmd.exe need', () => {
    // Non-ASCII text in a BOM-less script is read in the ANSI code page.
    expect([...scriptBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const wrapper = readFileSync(path.join(DIR, 'earthquake-alert.cmd'));
    expect(wrapper.every((byte) => byte < 0x80)).toBe(true);
  });
});
