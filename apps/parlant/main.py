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
  PARLANT_HOME        where sessions and customers persist (SQLite); read by
                      Parlant at import, so set it in the environment
"""

import asyncio

import parlant.sdk as p

from travel_agent import anthropic_thinking
from travel_agent.agent import (
    DEFAULT_INTAKE_EFFORT,
    DEFAULT_PLANNING_EFFORT,
    effort_from_env,
    setup,
)

anthropic_thinking.install()


async def main() -> None:
    async with p.Server(
        models={"*": "anthropic"},
        session_store="local",
        customer_store="local",
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
