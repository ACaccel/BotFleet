/**
 * Discord's ceilings on an autocomplete response.
 *
 * Platform facts, so they live at the Discord boundary rather than with
 * the dispatcher that enforces them: `handlers` and `plugins` are
 * sibling layers and both may reach for these, and a pure suggestion
 * builder should not have to import a dispatcher to learn how long a
 * value may be.
 */

/** Choices Discord will accept in one response; the rest are dropped. */
export const MAX_AUTOCOMPLETE_CHOICES = 25;

/** Per-field ceiling, applied to a choice name and a choice value alike. */
export const MAX_AUTOCOMPLETE_FIELD_LENGTH = 100;
