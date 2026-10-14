/**
 * Redaction coverage for the typed environment.
 *
 * Every secret-shaped key of `Env` must have a lower-cased entry in
 * `REDACT_FIELD_NAMES`, otherwise a structured log that happens to
 * carry that field — a config dump, an error context, an axios request
 * config — prints the credential in clear text. Deriving the expectation
 * from `ENV_KEYS` means a new key cannot be added without either covering
 * it or failing here.
 */
import { describe, expect, it } from 'vitest';

import { ENV_KEYS } from '../../../../src/core/config/env';
import { REDACT_FIELD_NAMES, buildPinoRedactPaths } from '../../../../src/core/config/redact';

/**
 * A key is treated as credential-bearing when its name carries one of
 * the usual secret markers. `CLIENT_ID`, `PORT`, `NODE_ENV` and
 * `LOG_LEVEL` are deliberately outside it — they are not secrets.
 */
const SECRET_SHAPED = /TOKEN|KEY|SECRET|PASSWORD|URI/;

const covered = new Set(REDACT_FIELD_NAMES.map((n) => n.toLowerCase()));

describe('REDACT_FIELD_NAMES', () => {
  it('covers every secret-shaped Env key', () => {
    const secretKeys = ENV_KEYS.filter((key) => SECRET_SHAPED.test(key));
    // Guard against the predicate silently matching nothing.
    expect(secretKeys.length).toBeGreaterThan(5);

    const uncovered = secretKeys.filter((key) => !covered.has(key.toLowerCase()));
    expect(
      uncovered,
      'Add the lower-cased key (and its camelCase form) to REDACT_FIELD_NAMES.',
    ).toEqual([]);
  });

  it('does not redact the non-secret Env keys', () => {
    for (const key of ['CLIENT_ID', 'PORT', 'NODE_ENV', 'LOG_LEVEL']) {
      expect(covered.has(key.toLowerCase())).toBe(false);
    }
  });

  it('derives nested pino redact paths for every field', () => {
    const paths = buildPinoRedactPaths();
    for (const field of ['xai_api_key', 'cwa_api_key']) {
      expect(paths).toContain(field);
      expect(paths).toContain(`*.${field}`);
    }
  });
});
