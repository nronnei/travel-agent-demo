import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sslOptions } from './ssl-options.js';

const VAR = 'DATABASE_SSL_ROOT_CERT';

describe('sslOptions', () => {
  it('verifies against the CA when one is given', () => {
    const ca = join(mkdtempSync(join(tmpdir(), 'ca-')), 'ca.crt');
    writeFileSync(ca, 'PEM');
    expect(sslOptions('postgresql://u:p@db-rw:5432/api', ca, VAR)).toEqual({
      ca: 'PEM',
      rejectUnauthorized: true,
    });
  });

  it('allows plain text to a local database without a CA', () => {
    expect(sslOptions('postgres://u:p@localhost:5433/x', undefined, VAR)).toBe(false);
    expect(sslOptions('postgres://u:p@127.0.0.1/x', undefined, VAR)).toBe(false);
  });

  it('refuses a remote host without a CA', () => {
    expect(() => sslOptions('postgresql://u:p@db-rw:5432/api', undefined, VAR)).toThrow(
      /DATABASE_SSL_ROOT_CERT is not set.*db-rw/,
    );
  });

  it('rejects an sslmode in the URL, which would override the CA check', () => {
    expect(() =>
      sslOptions('postgresql://u:p@db-rw/api?sslmode=require', 'x', VAR),
    ).toThrow(/Remove sslmode/);
  });
});
