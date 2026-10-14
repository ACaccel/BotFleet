/**
 * IoC barrel. Composition roots and tests import from here:
 *   import { createContainer } from '@core/ioc';
 *
 * This module owns the container *mechanism* only; the catalog of what gets
 * bound lives with the composition root in
 * [src/bot/tokens.ts](../../bot/tokens.ts).
 *
 * Layered code must not import from this module (see the
 * `no-restricted-imports` rule in eslint.config.mjs). Dependencies arrive via
 * constructor parameters, not a global container (service-locator
 * anti-pattern).
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
