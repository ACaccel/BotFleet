/**
 * Minimal Result sum type.
 *
 * Roll-your-own rather than `neverthrow` so `E` can be constrained to our
 * `DomainError` taxonomy at the call site. Async chaining lives at the
 * use-case layer (`Promise<Result<T, DomainError>>`).
 *
 * Contract (enforced by review, not by the type system):
 *   - A function whose return type is `Result<T, E>` MUST NOT throw a
 *     `DomainError`. Programmer errors (TypeError, assertion failures)
 *     may escape; they are not part of the Result channel.
 *   - `unwrap()` exists only for tests. Production code matches on
 *     `isOk` / `isErr` (or uses `unwrapOr`).
 */
import type { DomainError } from '../errors/domain-error';

/**
 * Open bound for `Result`'s error channel. The DomainError class
 * constrains Params to `Readonly<Record<string, string | number>> |
 * undefined`, so the bound here uses `any` rather than `unknown` —
 * `unknown` would violate the parent constraint. The widening only
 * affects the type parameter's structural bound; value-level
 * narrowing on `Err<E>` is preserved (callers holding the concrete
 * subclass still see typed params on `.error.messageParams`). The
 * eslint-disable is the targeted exception for this one alias.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DomainErrorBound = DomainError<string, any>;

/** Discriminated, immutable. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E extends DomainErrorBound = DomainErrorBound> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => Object.freeze({ ok: true as const, value });
export const err = <E extends DomainErrorBound>(error: E): Err<E> =>
  Object.freeze({ ok: false as const, error });

export const isOk = <T, E extends DomainErrorBound>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E extends DomainErrorBound>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Transform the success value. The error channel is untouched. */
export const map = <T, U, E extends DomainErrorBound>(
  r: Result<T, E>,
  fn: (v: T) => U,
): Result<U, E> => (r.ok ? ok(fn(r.value)) : r);

/** Transform the error value. The success channel is untouched. */
export const mapErr = <T, E extends DomainErrorBound, F extends DomainErrorBound>(
  r: Result<T, E>,
  fn: (e: E) => F,
): Result<T, F> => (r.ok ? r : err(fn(r.error)));

/** Monadic bind. The downstream function may return a different success type. */
export const andThen = <T, U, E extends DomainErrorBound>(
  r: Result<T, E>,
  fn: (v: T) => Result<U, E>,
): Result<U, E> => (r.ok ? fn(r.value) : r);

/** Return the success value or a fallback. Never throws. */
export const unwrapOr = <T, E extends DomainErrorBound>(r: Result<T, E>, fallback: T): T =>
  r.ok ? r.value : fallback;

/**
 * Test-only: assert success and return the value, or throw the wrapped
 * DomainError if the result is Err. Production code MUST match on
 * `isOk` / `isErr` instead — this helper exists to keep test arrange
 * blocks readable.
 */
export const unwrap = <T, E extends DomainErrorBound>(r: Result<T, E>): T => {
  if (r.ok) return r.value;
  throw r.error;
};
