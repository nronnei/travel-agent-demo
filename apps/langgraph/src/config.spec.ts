import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('prefers LANGGRAPH_INTAKE_API_URL over INTAKE_API_URL', () => {
    expect(
      loadConfig({
        INTAKE_API_URL: 'http://host.docker.internal:3000',
        LANGGRAPH_INTAKE_API_URL: 'http://127.0.0.1:3000',
      }).INTAKE_API_URL,
    ).toBe('http://127.0.0.1:3000');
  });

  it('defaults to a local database and treats empty values as unset', () => {
    const config = loadConfig({ LANGGRAPH_DB: '', PORT: '' });
    expect(config.LANGGRAPH_DB).toBe('checkpoints.db');
    expect(config.PORT).toBe(8900);
  });
});

describe('loadConfig (postgres)', () => {
  it('needs a URL for the postgres checkpointer', () => {
    expect(() => loadConfig({ LANGGRAPH_CHECKPOINTER: 'postgres' })).toThrow(
      /LANGGRAPH_DATABASE_URL/,
    );
    const config = loadConfig({
      LANGGRAPH_CHECKPOINTER: 'postgres',
      LANGGRAPH_DATABASE_URL: 'postgresql://langgraph:pw@db-rw:5432/langgraph',
      LANGGRAPH_DATABASE_SSL_ROOT_CERT: '/etc/postgres-ca/ca.crt',
    });
    expect(config.LANGGRAPH_CHECKPOINTER).toBe('postgres');
  });
});
