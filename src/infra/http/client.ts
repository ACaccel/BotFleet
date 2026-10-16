/**
 * Shared bounded HTTP client for outbound third-party calls.
 *
 * A bare `axios.get` has no timeout, so a stalled upstream leaves the promise
 * pending forever — inside an interaction, a deferred reply never edited and
 * a socket never released. Response size and redirect count are capped too:
 * responses are rendered into Discord messages, so nothing legitimate is
 * large, and an unbounded redirect chain amplifies server-side request
 * forgery.
 *
 * Prefer {@link getJson} / {@link postJson}: zod validation at the boundary
 * stops axios's `any` reaching handlers, where a shape change would surface
 * as a `TypeError` mistaken for a domain outcome. The generic binds to the
 * schema, not its output, so `z.infer` yields the parsed shape (which
 * differs from the input wherever a field has `.default()`).
 */
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import type { z } from 'zod';

/**
 * Per-request deadline. Chosen well below Discord's 15-minute
 * interaction window but above the tail latency of the public APIs the
 * callers use, so a slow-but-alive upstream still answers.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Ceiling on a response body a caller will read into memory. */
const MAX_CONTENT_LENGTH = 8 * 1024 * 1024;

/** Redirect hops followed before the request is abandoned. */
const MAX_REDIRECTS = 3;

/**
 * Bounded axios instance. Use this rather than the bare `axios`
 * default export.
 */
export const boundedHttp: AxiosInstance = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  maxContentLength: MAX_CONTENT_LENGTH,
  maxBodyLength: MAX_CONTENT_LENGTH,
  maxRedirects: MAX_REDIRECTS,
});

/**
 * `GET` `url` and validate the JSON body against `schema`.
 *
 * @throws {z.ZodError} when the body does not match — model the
 *   upstream's *empty* answer as a valid parse (a nullable field) so a
 *   real shape change stays distinguishable from "nothing found".
 */
export const getJson = async <S extends z.ZodTypeAny>(
  url: string,
  schema: S,
  config?: AxiosRequestConfig,
): Promise<z.infer<S>> => {
  const response = await boundedHttp.get<unknown>(url, config);
  return schema.parse(response.data) as z.infer<S>;
};

/** `POST` `url` and validate the JSON body against `schema`. See {@link getJson}. */
export const postJson = async <S extends z.ZodTypeAny>(
  url: string,
  schema: S,
  body?: unknown,
  config?: AxiosRequestConfig,
): Promise<z.infer<S>> => {
  const response = await boundedHttp.post<unknown>(url, body, config);
  return schema.parse(response.data) as z.infer<S>;
};
