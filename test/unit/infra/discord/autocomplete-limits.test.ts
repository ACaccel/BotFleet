/**
 * The two Discord autocomplete ceilings, pinned to their literals.
 *
 * Every other test asserts against the constants themselves, so raising
 * `MAX_AUTOCOMPLETE_CHOICES` to 30 would leave the whole suite green
 * and produce a REST 400 on every keystroke in production. These are
 * platform facts, not tunables — the only useful assertion is the
 * number Discord actually enforces.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_AUTOCOMPLETE_CHOICES,
  MAX_AUTOCOMPLETE_FIELD_LENGTH,
} from '../../../../src/infra/discord/autocomplete-limits';

describe('autocomplete limits', () => {
  it('caps a response at the 25 choices Discord accepts', () => {
    expect(MAX_AUTOCOMPLETE_CHOICES).toBe(25);
  });

  it('caps a choice name and value at the 100 characters Discord accepts', () => {
    expect(MAX_AUTOCOMPLETE_FIELD_LENGTH).toBe(100);
  });
});
