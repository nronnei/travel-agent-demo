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
