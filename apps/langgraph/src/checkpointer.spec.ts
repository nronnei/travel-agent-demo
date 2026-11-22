import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { createCheckpointer, type Checkpointer } from './checkpointer.js';
import { loadConfig } from './config.js';

// Real Postgres wire protocol, in process: PGlite behind a local socket (one
// connection at a time, hence poolMax: 1).
describe('createCheckpointer (postgres)', () => {
  let db: PGlite;
  let server: PGLiteSocketServer;
  let url: string;
  beforeAll(async () => {
    db = new PGlite();
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
    await server.start();
    url = `postgresql://postgres:x@127.0.0.1:${port}/postgres`;
  });
  afterAll(async () => {
    await server.stop();
    await db.close();
  });

  const counter = (checkpointer: Checkpointer) => {
    const State = Annotation.Root({
      count: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
    });
    return new StateGraph(State)
      .addNode('bump', () => ({ count: 1 }))
      .addEdge(START, 'bump')
      .addEdge('bump', END)
      .compile({ checkpointer: checkpointer.saver });
  };

  it('creates its tables and keeps a thread across checkpointer instances', async () => {
    const config = loadConfig({
      LANGGRAPH_CHECKPOINTER: 'postgres',
      LANGGRAPH_DATABASE_URL: url,
    });
    const thread = { configurable: { thread_id: 'thread-1' } };

    const first = await createCheckpointer(config, { poolMax: 1 });
    expect((await counter(first).invoke({}, thread)).count).toBe(1);
    await first.close();

    // A restarted service: a fresh pool over the same database.
    const second = await createCheckpointer(config, { poolMax: 1 });
    expect((await counter(second).invoke({}, thread)).count).toBe(2);
    await second.close();

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from checkpoints where thread_id = 'thread-1'`,
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('gives up after its retry budget when the database is unreachable', async () => {
    const config = loadConfig({
      LANGGRAPH_CHECKPOINTER: 'postgres',
      LANGGRAPH_DATABASE_URL: 'postgresql://langgraph:s3cret@127.0.0.1:1/langgraph',
    });
    const error = await createCheckpointer(config, { budgetMs: 200, initialDelayMs: 50 }).then(
      () => new Error('expected a failure'),
      (e: unknown) => e as Error,
    );
    expect(error.message).toMatch(/Postgres is unreachable after/);
    expect(error.message).not.toContain('s3cret');
  });

  it('refuses a remote database without a CA', async () => {
    const config = loadConfig({
      LANGGRAPH_CHECKPOINTER: 'postgres',
      LANGGRAPH_DATABASE_URL: 'postgresql://langgraph:pw@db-rw:5432/langgraph',
    });
    await expect(createCheckpointer(config)).rejects.toThrow(
      /LANGGRAPH_DATABASE_SSL_ROOT_CERT is not set/,
    );
  });
});
