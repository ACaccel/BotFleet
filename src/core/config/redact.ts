/**
 * Field names that must be redacted from any structured log.
 *
 * Lives in `core/config` rather than `core/logger` so that the env loader
 * (which must not depend on the logger to avoid a bootstrap circular
 * dependency) can reference the same list. The logger module imports this
 * constant during its own setup.
 *
 * Coverage rationale:
 *   - Discord/auth: token, authorization, bearer, cookie, set-cookie, x-api-key, proxy-authorization
 *   - Generic: apiKey, password, secret, client_secret, refresh_token, access_token, private_key
 *   - LLM providers in dependency graph (@anthropic-ai/sdk, openai, @google/generative-ai,
 *     xAI via the OpenAI-compatible client): anthropic*, openai*, google*, gemini*, xai*
 *   - Data store: mongoURI, mongo_inspect_uri
 *   - Other keys carried in the typed Env: cwa_api_key
 *
 * Every secret-shaped key of `Env` must appear here in lower case; the
 * `redact` unit suite asserts that closure.
 * Field name matching is case-insensitive; logger applies these as pino redact
 * paths including nested forms (see buildPinoRedactPaths below).
 */
export const REDACT_FIELD_NAMES = Object.freeze([
  // Generic auth / credential field names
  'token',
  'authorization',
  'bearer',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
  'proxy-authorization',
  'apiKey',
  'api_key',
  'password',
  'secret',
  'client_secret',
  'clientSecret',
  'refresh_token',
  'refreshToken',
  'access_token',
  'accessToken',
  'private_key',
  'privateKey',

  // Data store
  'mongoURI',
  'mongo_uri',
  'mongo_inspect_uri',
  'mongoInspectUri',

  // LLM provider keys (project uses @anthropic-ai/sdk, openai, @google/generative-ai)
  'anthropic_api_key',
  'anthropicApiKey',
  'openai_api_key',
  'openaiApiKey',
  'google_api_key',
  'googleApiKey',
  'gemini_api_key',
  'geminiApiKey',
  'xai_api_key',
  'xaiApiKey',

  // Other keys carried in the typed Env
  'cwa_api_key',
  'cwaApiKey',
] as const);

/**
 * Pino-compatible redact path list derived from REDACT_FIELD_NAMES.
 *
 * Covers up to four levels of nesting so axios error shapes (which often
 * surface as `err.config.headers.authorization`, depth 3 from the log root
 * and depth 4 when nested under `{err}`) are caught.
 */
export const buildPinoRedactPaths = (): readonly string[] => {
  const depths = ['', '*.', '*.*.', '*.*.*.'];
  return Object.freeze(
    REDACT_FIELD_NAMES.flatMap((field) => depths.map((prefix) => `${prefix}${field}`)),
  );
};
