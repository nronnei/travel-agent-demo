import { openPool } from './database.module.js';

describe('openPool', () => {
  it('gives up after its retry budget, without putting the password in the error', async () => {
    const started = Date.now();
    const error = await openPool('postgres://api:s3cret@127.0.0.1:1/api', undefined, {
      budgetMs: 300,
      initialDelayMs: 50,
    }).then(
      () => new Error('expected openPool to fail'),
      (e: unknown) => e as Error,
    );
    expect(error.message).toMatch(/Postgres is unreachable after/);
    expect(error.message).not.toContain('s3cret');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
