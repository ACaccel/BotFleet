/**
 * Abstract base for every recoverable, business-meaningful error.
 *
 *   - `code`: stable machine-readable identifier; part of the public API,
 *     so changes follow SemVer.
 *   - `messageKey`: required i18n key, so the outermost interaction catch
 *     can always render a string without a fallback branch. Use real keys
 *     even for internal-only errors.
 *   - `context`: see {@link ErrorContext}; `operation` is required.
 *   - `cause`: the original error, preserved via ES2022 `Error.cause`.
 *
 * Callers narrow with `instanceof`; there is no discriminant field.
 *
 * Subclasses pick a default `messageKey` (overridable) and never add fields
 * outside `context`, since every extra attribute weakens the redactor.
 * Promote a field that deserves typing to a typed subclass instead.
 *
 * Invariant violations throw native `TypeError` / `RangeError`;
 * `DomainError` covers expected failure modes only.
 */
import type { ErrorContext } from './error-context';

export interface DomainErrorInit<
  Code extends string,
  Params extends Readonly<Record<string, string | number>> | undefined = undefined,
> {
  readonly code: Code;
  readonly messageKey: string;
  readonly context: ErrorContext;
  readonly cause?: unknown;
  readonly messageParams?: Params;
}

/**
 * The honest type of a value narrowed by `instanceof DomainError`.
 *
 * `instanceof` on a generic class narrows to `DomainError<any, any>`, so
 * `code` and `messageParams` arrive as `any` and slip past every check
 * the strict profile makes — a rendering boundary can pass an array
 * where the translator expects params, and nothing complains. Anchoring
 * the narrowed value to this alias restores `string` and the catalog
 * params shape at the one place it matters.
 */
export type AnyDomainError = DomainError<
  string,
  Readonly<Record<string, string | number>> | undefined
>;

export abstract class DomainError<
  Code extends string = string,
  Params extends Readonly<Record<string, string | number>> | undefined = undefined,
> extends Error {
  public readonly code: Code;
  public readonly messageKey: string;
  public readonly context: ErrorContext;
  public readonly messageParams: Params;

  protected constructor(init: DomainErrorInit<Code, Params>) {
    super(`${init.code}: ${init.messageKey}`, { cause: init.cause });
    this.name = new.target.name;
    this.code = init.code;
    this.messageKey = init.messageKey;
    this.context = init.context;
    // Cast is the single place where Params's optionality is collapsed;
    // subclasses that omit `messageParams` get `undefined` as expected.
    this.messageParams = (init.messageParams ?? undefined) as Params;
  }

  /**
   * JSON shape consumed by the pino structured logger. Excludes the
   * native `stack` string (pino serialises it through `err`) and
   * preserves `cause` via the standard ES2022 property.
   */
  public toJSON(): Readonly<Record<string, unknown>> {
    return {
      name: this.name,
      code: this.code,
      messageKey: this.messageKey,
      messageParams: this.messageParams,
      context: this.context,
      cause: this.cause,
    };
  }
}
