import { describe, expect, it } from 'vitest';
import { scrubForLog } from '../../../../src/core/logger/scrub-for-log';

describe('scrubForLog', () => {
  it('passes scalars through unchanged', () => {
    expect(scrubForLog('hi')).toBe('hi');
    expect(scrubForLog(42)).toBe(42);
    expect(scrubForLog(true)).toBe(true);
    expect(scrubForLog(null)).toBe(null);
    expect(scrubForLog(undefined)).toBe(undefined);
  });

  it('replaces top-level sensitive field values with [Redacted]', () => {
    const out = scrubForLog({
      bot: 'b1',
      token: 'secret-token',
      apiKey: 'sk-123',
      mongoURI: 'mongodb://user:pw@host', // gitleaks:allow
      okField: 'visible',
    }) as Record<string, unknown>;
    expect(out.token).toBe('[Redacted]');
    expect(out.apiKey).toBe('[Redacted]');
    expect(out.mongoURI).toBe('[Redacted]');
    expect(out.bot).toBe('b1');
    expect(out.okField).toBe('visible');
  });

  it('redacts case-insensitively', () => {
    const out = scrubForLog({ Authorization: 'Bearer x', TOKEN: 'y' }) as Record<string, unknown>;
    expect(out.Authorization).toBe('[Redacted]');
    expect(out.TOKEN).toBe('[Redacted]');
  });

  it('redacts nested sensitive fields', () => {
    const out = scrubForLog({
      req: { headers: { authorization: 'Bearer x', 'x-api-key': 'k' } },
    }) as { req: { headers: Record<string, unknown> } };
    expect(out.req.headers.authorization).toBe('[Redacted]');
    expect(out.req.headers['x-api-key']).toBe('[Redacted]');
  });

  it('reshapes Error instances to drop ad-hoc fields (axios config etc.)', () => {
    const e = new Error('boom') as Error & {
      config?: { headers?: { authorization?: string } };
      code?: string;
    };
    e.code = 'EAUTH';
    e.config = { headers: { authorization: 'Bearer secret' } };
    const out = scrubForLog(e) as Record<string, unknown>;
    expect(out.name).toBe('Error');
    expect(out.message).toBe('boom');
    expect(out.code).toBe('EAUTH');
    expect('config' in out).toBe(false);
  });

  it('recurses into Error.cause (ES2022)', () => {
    const root = new Error('root cause') as Error & { token?: string };
    root.token = 'should-not-leak';
    const wrapper = new Error('wrap', { cause: root });
    const out = scrubForLog(wrapper) as { cause: Record<string, unknown> };
    expect(out.cause.name).toBe('Error');
    expect(out.cause.message).toBe('root cause');
    // `token` is an ad-hoc Error field and is dropped by the Error
    // unwrap shape (not even passed through redaction — Error unwrap
    // is strict whitelist).
    expect('token' in out.cause).toBe(false);
  });

  it('handles arrays by recursing element-wise', () => {
    const out = scrubForLog([{ token: 'x' }, { ok: 'visible' }]) as Array<Record<string, unknown>>;
    expect(out[0]?.token).toBe('[Redacted]');
    expect(out[1]?.ok).toBe('visible');
  });

  it('caps recursion depth so a cyclic-style deep tree does not blow up', () => {
    // Build a 6-deep nested object; depths beyond MAX_DEPTH (4) collapse
    // to '[Redacted]'.
    type Nest = { next?: Nest; leaf?: string };
    const deep: Nest = {};
    let cursor: Nest = deep;
    for (let i = 0; i < 6; i++) {
      cursor.next = {};
      cursor = cursor.next;
    }
    cursor.leaf = 'sentinel';
    const out = scrubForLog(deep);
    // Walking 5 levels of `next` should still find leaves; level 5+
    // collapses.
    expect(out).toBeDefined();
    expect(JSON.stringify(out).includes('[Redacted]')).toBe(true);
  });

  it('drops functions to a placeholder', () => {
    const out = scrubForLog({ fn: () => 1, name: 'visible' }) as Record<string, unknown>;
    expect(out.fn).toBe('[Redacted]');
    expect(out.name).toBe('visible');
  });
});

describe('scrubForLog URL credentials', () => {
  it('redacts a credential carried in a query string', () => {
    // Some upstreams accept the key only as a query parameter, so
    // field-name redaction alone cannot reach it.
    const out = scrubForLog('https://api.example/v1/forecast?apikey=SUPERSECRET&language=zh-tw');
    expect(out).not.toContain('SUPERSECRET');
    expect(out).toContain('language=zh-tw');
  });

  it('redacts a credential inside an Error message and stack', () => {
    const err = new Error('Request failed: https://api.example/v1/models?key=SUPERSECRET');
    const out = scrubForLog(err) as { message: string; stack?: string };
    expect(out.message).not.toContain('SUPERSECRET');
    expect(out.stack ?? '').not.toContain('SUPERSECRET');
  });

  it('leaves ordinary prose untouched', () => {
    expect(scrubForLog('the key=value convention is fine here')).toBe(
      'the key=value convention is fine here',
    );
  });

  it('redacts the userinfo of a Mongo connection string', () => {
    // `buildGuildMongoUri` produces exactly this shape and mongoose
    // embeds it verbatim in MongoServerSelectionError messages.
    const out = scrubForLog(
      'MongoServerSelectionError: mongodb://acaccel:hunter2@127.0.0.1:27017/12345?authSource=admin failed', // gitleaks:allow
    ) as string;
    expect(out).not.toContain('hunter2');
    expect(out).toContain('mongodb://');
    expect(out).toContain('127.0.0.1:27017');
  });

  it('redacts a longer parameter name the shorter alternative would shadow', () => {
    const out = scrubForLog(
      'https://idp.test/token?client_secret=SECRET&refresh_token=RT&id_token=IT&grant_type=code',
    ) as string;
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('RT');
    expect(out).not.toContain('IT');
    expect(out).toContain('grant_type=');
  });

  it('redacts a credential in a URL that carries no query string', () => {
    const out = scrubForLog('redis://admin:s3cr3t@cache.internal:6379') as string;
    expect(out).not.toContain('s3cr3t');
  });
});
