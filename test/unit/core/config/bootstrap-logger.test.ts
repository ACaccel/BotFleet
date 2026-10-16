import { describe, expect, it } from 'vitest';

import { createBootstrapLogger } from '../../../../src/core/config/bootstrap-logger';

describe('createBootstrapLogger', () => {
  it('with fileRouter:false yields a console-only logger that needs no `bot` binding', () => {
    // Regression for the `npm run register` crash: the file-router sink throws
    // on any record missing a `bot` binding. The register CLI has none, so
    // it must opt out of the file router. With fileRouter:false the sink
    // is never attached, so logging a `bot`-less record is safe.
    const logger = createBootstrapLogger({ component: 'register' }, { fileRouter: false });
    expect(typeof logger.info).toBe('function');
    expect(() => logger.info({ component: 'register' }, 'no bot binding here')).not.toThrow();
  });
});
