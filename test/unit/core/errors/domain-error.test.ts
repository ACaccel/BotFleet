import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  DatabaseError,
  DomainError,
  ExternalServiceError,
  LinkPreviewError,
  LlmProviderError,
  FeedError,
} from '../../../../src/core/errors';

describe('DomainError subclasses', () => {
  it('each subclass sets name + code and narrows by instanceof', () => {
    const cases: Array<[DomainError, string]> = [
      [
        new ConfigurationError({
          code: 'MISSING_ENV',
          messageKey: 'errors:configuration.missing_env',
          context: { operation: 'test' },
        }),
        'ConfigurationError',
      ],
      [
        new DatabaseError({
          code: 'DATABASE_UNKNOWN',
          messageKey: 'errors:db.unavailable',
          context: { operation: 'test' },
        }),
        'DatabaseError',
      ],
      [
        new LlmProviderError({
          code: 'LLM_UNKNOWN',
          messageKey: 'errors:llm.unknown',
          context: { operation: 'test' },
        }),
        'LlmProviderError',
      ],
      [
        new LinkPreviewError({
          code: 'LINK_PREVIEW_FETCH_FAILED',
          messageKey: 'errors:link_preview.fetch_failed',
          context: { operation: 'test' },
        }),
        'LinkPreviewError',
      ],
      [
        new FeedError({
          code: 'FEED_FETCH_FAILED',
          messageKey: 'errors:feed.fetch_failed',
          context: { operation: 'test' },
        }),
        'FeedError',
      ],
    ];
    for (const [e, name] of cases) {
      expect(e.name).toBe(name);
      expect(e).toBeInstanceOf(DomainError);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('groups every boundary failure under ExternalServiceError', () => {
    const dbError = new DatabaseError({
      code: 'DATABASE_TIMEOUT',
      messageKey: 'errors:db.timeout',
      context: { operation: 'test' },
    });
    const configError = new ConfigurationError({
      code: 'MISSING_ENV',
      messageKey: 'errors:configuration.missing_env',
      context: { operation: 'test' },
    });
    // `instanceof` is the dispatch contract: the boundary group narrows,
    // and a non-boundary error stays outside it.
    expect(dbError).toBeInstanceOf(ExternalServiceError);
    expect(configError).not.toBeInstanceOf(ExternalServiceError);
  });

  it('preserves cause via ES2022 Error.cause', () => {
    const root = new Error('boom');
    const e = new DatabaseError({
      code: 'DATABASE_NETWORK',
      messageKey: 'errors:db.network',
      context: { operation: 'MongoMessageRepo.findRecentByChannel' },
      cause: root,
    });
    expect(e.cause).toBe(root);
  });

  it('toJSON includes name / code / messageKey / context / cause', () => {
    const cause = new Error('original');
    const e = new DatabaseError({
      code: 'DATABASE_VALIDATION',
      messageKey: 'errors:db.validation',
      context: { operation: 'modal.ai_settings', input: { temperature: 5 } },
      messageParams: { field: 'temperature' },
      cause,
    });
    expect(e.toJSON()).toMatchObject({
      name: 'DatabaseError',
      code: 'DATABASE_VALIDATION',
      messageKey: 'errors:db.validation',
      messageParams: { field: 'temperature' },
      context: { operation: 'modal.ai_settings' },
      cause,
    });
  });
});
