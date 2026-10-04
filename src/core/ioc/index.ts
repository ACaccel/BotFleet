/**
 * IoC barrel. Composition roots and tests import from here:
 *   import { createContainer } from '@core/ioc';
 *
 * This module owns the container *mechanism* only. The catalog of what
 * gets bound lives with the composition root at
 * [src/bot/tokens.ts](../../bot/tokens.ts), because naming the concrete
 * services would force `core` to import from `infra` / `persistence` /
 * `plugins`.
 *
 * Layered code (`persistence/`, `infra/`, `handlers/`, `plugins/`) must
 * not import from this module — see the `no-restricted-imports` rule in
 * eslint.config.mjs. Dependencies are delivered via constructor
 * parameters from the composition root, not pulled from a global
 * container (service-locator anti-pattern).
 */
export {
  createContainer,
  token,
  ServiceResolutionError,
  DuplicateRegistrationError,
  type ServiceToken,
  type Resolver,
  type ServiceContainer,
} from './container';
