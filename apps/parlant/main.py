"""Serves the Parlant travel agent on :8800 (override with PORT).

Env:
  ANTHROPIC_API_KEY   Claude models
  VOYAGE_API_KEY      embeddings (Anthropic has none; Parlant's default is Voyage)
  INTAKE_API_URL      the Nest API, for the guest's intake record
  INTAKE_API_TOKEN    shared token the Nest API expects on intake calls
  SEARCH_API_TOKEN    Bearer token for the Nest API's /api/search/web (optional:
                      without it the web_search tool answers with a fallback)
  PARLANT_INTAKE_EFFORT    Parlant effort for intake turns (default high:
                           Sonnet 5.5 replies; medium and below use Haiku 5.5)
  PARLANT_PLANNING_EFFORT  effort for planning turns (default high: Sonnet 5.5)
  PARLANT_DATABASE_URL  Postgres for sessions and customers (Helm sets it from
                        the cluster); without it they're SQLite under PARLANT_HOME
  PARLANT_DATABASE_SSL_ROOT_CERT  the cluster CA; required for any database
                        host other than localhost
  PARLANT_HOME        SQLite stores (without Postgres), the embedding cache and
                      logs; read by Parlant at import, so set it in the environment
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / _METRICS_ENDPOINT  turn on Parlant's
                      OpenTelemetry export and the Anthropic token
                      instrumentation (travel_agent/telemetry.py)
  PARLANT_CONSOLE_SPANS=1  print spans to stdout again (travel_agent/otel_quiet.py)
"""

import asyncio
import os
from contextlib import AsyncExitStack

import parlant.sdk as p
from parlant.core.common import IdGenerator
from parlant.core.customers import CustomerDocumentStore
from parlant.core.sessions import SessionDocumentStore

from travel_agent import anthropic_thinking, otel_quiet, telemetry
from travel_agent.agent import (
    DEFAULT_INTAKE_EFFORT,
    DEFAULT_PLANNING_EFFORT,
    effort_from_env,
    setup,
)
from travel_agent.postgres_db import PostgresDocumentDatabase

anthropic_thinking.install()
otel_quiet.install()
telemetry.install_llm_instrumentation()


# Parlant's default, which `local` stores also get: a store whose schema changed in
# a Parlant upgrade fails loudly (MigrationRequired) rather than rewriting stored
# documents. Migrating is a deliberate step: run once with migrate=True.
MIGRATE = False


async def main() -> None:
    async with AsyncExitStack() as stack:
        session_store: str | SessionDocumentStore = "local"
        customer_store: str | CustomerDocumentStore = "local"
        if dsn := os.environ.get("PARLANT_DATABASE_URL"):
            db = await stack.enter_async_context(
                PostgresDocumentDatabase(dsn, os.environ.get("PARLANT_DATABASE_SSL_ROOT_CERT"))
            )
            session_store = await stack.enter_async_context(
                SessionDocumentStore(db, allow_migration=MIGRATE, collections_prefix="sessions")
            )
            customer_store = await stack.enter_async_context(
                CustomerDocumentStore(
                    IdGenerator(), db, allow_migration=MIGRATE, collections_prefix="customers"
                )
            )
        async with p.Server(
            models={"*": "anthropic"},
            session_store=session_store,
            customer_store=customer_store,
            migrate=MIGRATE,
            # Tilt restarts the process on synced edits; no file watching in-process.
            hot_reload=False,
        ) as server:
            await setup(
                server,
                intake_effort=effort_from_env("PARLANT_INTAKE_EFFORT", DEFAULT_INTAKE_EFFORT),
                planning_effort=effort_from_env("PARLANT_PLANNING_EFFORT", DEFAULT_PLANNING_EFFORT),
            )
        # The server starts serving when the block exits, and runs until stopped.


if __name__ == "__main__":
    asyncio.run(main())
