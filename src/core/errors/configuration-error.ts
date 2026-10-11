/**
 * The deployment is misconfigured: configuration is missing or malformed,
 * or the host lacks something the code requires (such as the canvas font).
 *
 * Startup validation raises it fail-fast: the process exits ≠ 0 so the
 * supervisor restarts and ops sees the failure immediately. Host checks run
 * at setup and release preparation too (`ensureCanvasFont`). A fault only a
 * feature in use can observe — the font when a chart first renders, the
 * archive settings an `/archive` interaction re-reads — is raised by that
 * feature; the interaction boundary logs it and answers with a trace ID.
 * Never retried: retrying cannot fix the deployment.
 */
import { DomainError, type DomainErrorInit } from './domain-error';

type ConfigurationErrorCode =
  | 'MISSING_ENV'
  | 'INVALID_ENV'
  | 'INVALID_CONFIG_JSON'
  | 'UNSUPPORTED_FEATURE'
  /**
   * A plugin called `PluginInitContext.registerInstance` outside the
   * `init` phase. Raised by the lifecycle runner's stage guard; see
   * `core/plugin/host/lifecycle.ts`. Reused rather than promoted to a
   * dedicated error subclass because the violation is a startup-time
   * composition bug, equivalent in severity to the existing
   * `INVALID_CONFIG_JSON` / `MISSING_ENV` family.
   */
  | 'LIFECYCLE_PHASE_VIOLATION'
  /**
   * `client.login()` rejected (invalid token, network failure, Discord
   * outage). Raised by {@link BaseBot.login} so {@link BaseBot.run}
   * rejects rather than silently entering a half-started state.
   */
  | 'BOT_LOGIN_FAILED'
  /**
   * `client.login()` resolved but `client.user` was still unset, meaning
   * the gateway handshake did not complete the way Discord.js usually
   * guarantees. Treated as a fatal startup failure.
   */
  | 'BOT_LOGIN_NO_USER';

export class ConfigurationError<
  P extends Readonly<Record<string, string | number>> | undefined = undefined,
> extends DomainError<ConfigurationErrorCode, P> {
  public constructor(init: DomainErrorInit<ConfigurationErrorCode, P>) {
    super(init);
  }
}
