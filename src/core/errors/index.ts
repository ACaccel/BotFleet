/**
 * Domain error barrel. Consumers import named subclasses from here:
 *
 *   import { DatabaseError, ConfigurationError } from '@core/errors';
 *
 * Dispatch contract: narrow with `instanceof`. `DomainError` is the
 * root; `ExternalServiceError` groups every boundary failure and its
 * four subclasses name the boundary. There is no discriminant string
 * field — `instanceof` already answers the question, and a parallel
 * `kind` tag can only drift out of sync with the class hierarchy.
 */
export type { ErrorContext } from './error-context';
export { isTransientNetworkError } from './transient-network-error';
export { DomainError, type DomainErrorInit, type AnyDomainError } from './domain-error';
export { ConfigurationError } from './configuration-error';
export {
  ArchiveControlError,
  type ArchiveControlErrorCode,
  ArchiveAccessError,
  ArchiveInputError,
} from './archive-control-error';
export { DbInspectError, type DbInspectErrorCode } from './db-inspect-error';
export {
  ExternalServiceError,
  type ExternalServiceErrorCode,
  DatabaseError,
  type DatabaseErrorCode,
  LlmProviderError,
  type LlmProviderErrorCode,
  LinkPreviewError,
  type LinkPreviewErrorCode,
  FeedError,
  type FeedErrorCode,
} from './external-service-error';
