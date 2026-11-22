# Agent framework comparison

The same travel concierge is built three times, so the agent frameworks can be
compared on one product:

- **Inkeep**: `apps/agents`, the existing agent with intake and planner sub-agents.
- **Parlant**: `apps/parlant`, Parlant 4.0.5 in Python, built the Parlant way.
- **LangGraph**: `apps/langgraph`, LangGraph.js 1.7.5 in TypeScript: an explicit
  graph behind a small Fastify server, with a SQLite checkpointer.

All three sit behind the same web app and Nest API. The API's `CHAT_BACKEND`
(`inkeep` by default, `parlant` or `langgraph`) picks which one serves chat.
The web app reads it from `GET /api/config`.

## Running it

```sh
tilt up -- --chat-backend=parlant   # or langgraph, or inkeep (the default)
```

Only the selected in-cluster agent (Parlant or LangGraph) is built and
deployed in the dev namespace; Inkeep runs outside it. Switching backends keeps
each agent's volume, so its saved conversations survive. Parlant's REST API is port-forwarded to
`localhost:8800`, LangGraph's server to `localhost:8900`.

Parlant needs a Secret, named in `parlant.existingSecret`, with these keys:

| Key                 | Purpose                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Claude models                                                                   |
| `VOYAGE_API_KEY`    | Embeddings. Anthropic has none, and Parlant uses Voyage by default.             |
| `INTAKE_API_TOKEN`  | The same value the API expects                                                  |
| `SEARCH_API_TOKEN`  | Optional. The web search token the API expects; without it the tool falls back. |

Under Tilt you don't create it by hand. Unless the homelab values name a
secret, the Tiltfile builds `travel-agent-parlant-dev` from the repo's `.env`,
and `travel-agent-api-dev` (`INTAKE_API_TOKEN`, `TAVILY_API_KEY` and
`SEARCH_API_TOKEN`) for the API. The homelab Inkeep reads `SEARCH_API_TOKEN`
from its own `inkeep-secrets`, so copy that value into `.env`. Turn search off
with `tilt args -- --search-provider=off`. Elsewhere,
the chart's `values.yaml` has the `kubectl create secret` command.

Voyage's free tier, before a payment method is added, allows 3 requests a
minute. That is too few for Parlant to index the agent at startup. Adding a
payment method lifts the limit, and the free 200M tokens still apply.

LangGraph needs a Secret, named in `langgraph.existingSecret`, with
`ANTHROPIC_API_KEY`, `INTAKE_API_TOKEN`, `SEARCH_API_TOKEN` (optional) and
`LANGGRAPH_API_TOKEN`, the Bearer token the API sends it. The API needs the same
`LANGGRAPH_API_TOKEN` in its own Secret. Under Tilt both come from `.env`
(`travel-agent-langgraph-dev` and `travel-agent-api-dev`). Older `.env` files
lack the token: add `LANGGRAPH_API_TOKEN=$(openssl rand -base64 32)`, or
LangGraph chat returns a 503 that names it.

## What is shared, and what differs

The chat screen, the scripted opening (greeting, name and title), the widgets
(`IntakeComponents.tsx`) and the intake record in the API are shared. Each
backend has its own chat engine (`apps/web/src/chat/`) behind the same
`ChatEngine` interface.

|                        | Inkeep                                                                                                                                                                                   | Parlant                                                                                                                                                                                                                                                       | LangGraph                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire protocol          | AI SDK UI message stream from `POST /api/chat`. The API proxies Inkeep's stream.                                                                                                         | The session event log. The guest's message is posted as an event, and the reply arrives on an SSE stream of events that stays open. The API passes it through with ownership checks (`/api/parlant/:id/*`).                                                   | LangGraph's own run stream (`values`, `messages`, `updates`, `custom` events) from `POST /api/langgraph/:id/stream`, read in the browser with the SDK's `useStream` and a custom transport. The API checks ownership and builds the upstream body; our Fastify server writes the SSE itself (the SDK has no server helper for a custom server). |
| Streaming              | Tokens, through the AI SDK                                                                                                                                                               | Tokens. The message event grows in place, and each event is followed on its own stream until its `chunks` end in `null`.                                                                                                                                      | Tokens, through the `messages` stream mode, merged by the SDK's message manager                                                                                                                                                                                                                                                                 |
| Status                 | None (status updates are off)                                                                                                                                                            | `acknowledged` / `processing` / `typing` / `ready` events. These drive the typing indicator.                                                                                                                                                                  | None from the framework. The engine shows "Searching the web…" from the search tool's `custom` event                                                                                                                                                                                                                                            |
| Structure              | Two sub-agents. The model decides when to transfer.                                                                                                                                      | One agent with rules. Intake and planning are gated in code on `briefConfirmed`, so the hand-off is deterministic.                                                                                                                                            | An explicit graph: `loadIntake` routes to the intake or planner node on `briefConfirmed`, so the hand-off is deterministic and in code                                                                                                                                                                                                          |
| Widgets                | Data components that the model emits as part of its reply                                                                                                                                | Tool results. Observations attach the tools when the conversation calls for them, and the widget travels in `ToolResult.metadata`, which the model never sees.                                                                                                | Tool calls that pause the graph with `interrupt()`. The widget is written to graph state before the pause, and the guest's answer resumes the graph as a `Command`, becoming the tool's result                                                                                                                                                  |
| Guest's details        | Context fetcher, templated into prompts                                                                                                                                                  | A `guest_brief` variable backed by a tool, refreshed every turn                                                                                                                                                                                               | Read from the intake API at the start of every run (`loadIntake`) and templated into the system prompt                                                                                                                                                                                                                                          |
| Brief edits in the app | Described to the agent in a note added to the next message                                                                                                                               | Saved to the intake record (`PUT /api/intake/:id/draft`) before the message is sent. The agent reads the new brief from the variable.                                                                                                                         | Saved to the intake record before the message is sent, as for Parlant                                                                                                                                                                                                                                                                           |
| Fixed lines            | Prompt wording                                                                                                                                                                           | Canned responses. In 4.0.5 these are style references, not enforced. See the findings below.                                                                                                                                                                  | Prompt wording (one fixed fallback line is code)                                                                                                                                                                                                                                                                                                |
| Models                 | Haiku 5.5 for intake (data components need forced tool choice, which Sonnet 5.5 rejects) and Sonnet 5.5 for planning                                                                     | `Effort.HIGH`: Sonnet 5.5 for replies, Haiku 5.5 for rule matching and review                                                                                                                                                                                 | Sonnet 5.5 for both. Widgets are ordinary tool calls with `tool_choice: auto`, so Sonnet works for intake. Thinking set to `between_tools` (Sonnet 5.5 rejects `disabled`)                                                                                                                                                                      |
| Web search             | An `mcpTool` on the planner, calling the API's MCP server (`POST /api/mcp`) with a Bearer token from Inkeep's memory credential store. The model sees the MCP server's tool description. | A `web_search` tool on the `trip-planning` policy, calling `POST /api/search/web` over REST (Parlant's MCP client can't send auth headers). It emits a `custom` event as it starts, so the app can show "Searching the web…" before the `tool` event arrives. | A `web_search` tool (LangChain `tool()`, run by a `ToolNode`) calling `POST /api/search/web` over REST. Sources ride in the ToolMessage `artifact`, which the model never sees. At most three searches per reply, enforced in code                                                                                                              |
| Storage                | Two Postgres-wire databases of its own: Doltgres (the manage DB, git-style versioned configs; not Postgres, so it can't run on CNPG) and Postgres (the run DB: conversations, auth), plus SpiceDB's Postgres. The homelab install's run and SpiceDB databases are on CNPG (`inkeep-db`). | Sessions and customers through a `DocumentDatabase`. 4.0.5 ships SQLite, MongoDB, S3 and Snowflake adapters, but no Postgres one: we wrote `travel_agent/postgres_db.py` (about 450 lines, asyncpg), and its own stores run on it unchanged. | An official Postgres checkpointer (`@langchain/langgraph-checkpoint-postgres`); `setup()` creates its tables. |

### Prompts: LangGraph against Inkeep

`apps/langgraph/src/prompts.ts` mirrors the Inkeep prompt
(`apps/agents/src/projects/travel-agent/agents/travel-agent.ts`): the same
purpose, style and tone, unbreakable rules, intake order and search guidance.
It's kept in step by hand. It differs where LangGraph does the job in code, or
where the live runs showed a problem.

|                        | Inkeep                                                                                                 | LangGraph                                                                                                                                                 | Why                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Widgets                | "Emit the InterestPicker / TripBrief component" (data components)                                      | "Call `suggest_interests` / `present_brief`" (ordinary tool calls)                                                                                        | Data components force a tool call, which Sonnet 5.5 rejects, so Inkeep's intake runs on Haiku. Plain tool calls let intake run on Sonnet.                                                                                                                                                                    |
| Widget answers         | Arrive as guest messages ("I'd like the trip to focus on: …")                                          | Come back as the tool's result, plus the guest's words as a message                                                                                       | The graph pauses on the widget and resumes with the structured answer.                                                                                                                                                                                                                                       |
| Hand-off               | "When the guest says … transfer to the travel planner"                                                 | No transfer rule. The intake prompt says the planner "takes over automatically"; the planner prompt says to open with one short line after a confirmation | The graph routes to the planner on `briefConfirmed`, read from the intake API, so the model doesn't decide.                                                                                                                                                                                                  |
| Brief edits in the app | A note prepended to the next message ("[I've edited the trip brief myself…]") and a rule explaining it | A "What the guest has entered so far" section, filled from the intake record                                                                              | As with Parlant, the app saves edits to the intake record before sending, and every run reloads it.                                                                                                                                                                                                          |
| Guest details          | Template placeholders filled by Inkeep's context fetcher                                               | `intakePrompt(intake)` / `plannerPrompt(intake)`, plain functions called on every model call                                                              | `loadIntake` reads the record at the start of each run.                                                                                                                                                                                                                                                      |
| Narration              | Nothing                                                                                                | "Everything you write is shown to the guest", plus the exact line to say with each widget                                                                 | In live runs the intake told the guest "The purpose is general, so I'll show the interest picker." The general rule alone still let it happen about one turn in five; pinned lines stopped it. Inkeep's components are part of the reply, so there's no tool step to narrate. Parlant uses canned responses. |
| Search                 | "At most three searches per reply"                                                                     | The same line, plus a line before searching ("Let me check what's on that week.") and a note that the intake's tools are finished                         | The cap is also enforced in code (`tool_choice: none` after three). The planner sees the intake's widget calls as text in its history.                                                                                                                                                                       |

## Findings while building

- **Parlant 4.0.5 has no journeys and no strict canned-response mode.**
  - Rules are policies (multi-step flows go in a procedure) and observations.
  - Canned responses are sent to the model as style examples. Simple lines come back verbatim; others are reworded. For example, the hand-off line came back as "Wonderful. Let's start planning your Porto getaway, Dr Lima."
  - Text returned in a tool's `ToolResult.canned_responses` takes precedence, and message review (`message_review=True`) is the closest thing to enforcement.
- **Thinking blocks broke every turn that showed a widget.**
  - Parlant replays signed thinking blocks across the steps of a turn after it has rewritten earlier messages, and Claude rejects them with "bound to a different conversation".
  - `travel_agent/anthropic_thinking.py` opts into the API's `drop_block` behaviour. Remove it once Parlant fixes this.
- **Rough edges in the REST API:**
  - Creating a customer whose id already exists returns a 500, not a 409. The API checks with `GET` first.
  - The event-list SSE sends each event once, so streamed messages need the per-event stream.
  - `PARLANT_HOME` is read when `parlant.sdk` is imported.
- **Embeddings:** with Anthropic you need a Voyage key. Without one, Parlant fails during indexing, not at startup.
- **Web search** uses one implementation in the Nest API (Tavily, with a cache and best-effort limits), so both agents get the same results. Run-through findings (searches per turn, latency, whether Inkeep's stream exposes MCP tool calls for the live indicator) are still to be recorded.
- **Latency:** in local runs with a stand-in embedder, intake turns took 3–7 s and planning turns about 8 s. Each turn makes several model calls: rule matching, tool evaluation, then the reply. Measured on the cluster, see the eval log below.

### Storage on Postgres (CloudNativePG)

Logged 2026-11-22, moving every backend onto one CNPG cluster per environment,
with a database and role per service (docs/plans/2026-11-22-cnpg-postgres.md).

- **LangGraph** was the easiest: swap `SqliteSaver` for `PostgresSaver` over a
  `pg.Pool` and call `setup()` once at startup. Nothing else changed.
- **Parlant** has no Postgres option, but its persistence is pluggable at two
  levels:
  - **`DocumentDatabase`** (about 10 methods): a generic document store that
    Parlant's own `SessionDocumentStore` and `CustomerDocumentStore` (and their
    schema migrations) sit on. This is what we implemented. Pass the entered
    stores to `p.Server(session_store=..., customer_store=...)`.
  - **`SessionStore` / `CustomerStore`** (19 + 9 methods), tied to Parlant's domain
    model. More work, and more likely to break on upgrades. A custom
    `CustomerStore` is also the hook for keeping guest PII out of Parlant's
    storage (see "Guest data and the model").
  - The ABCs live in `parlant.core.persistence`, not the SDK, so a minor release
    could change them. Our contract tests run against Parlant's own SQLite
    adapter as the reference, and should be re-run on every upgrade.
  - The SQLite reference loads a whole collection and filters in Python on every
    query, which grows with total history (all sessions' events share one
    collection). Our adapter pushes scalar `$eq` on `id` and `session_id` down to
    a GIN-indexed JSONB `@>`, after checking that those are the hot filters and
    that no document loader rewrites them.
  - Parlant's `migrate` defaults to `False`, which `local` stores inherit: a store
    whose schema changed fails with `MigrationRequired` instead of rewriting
    documents. We keep that default for the Postgres stores.
  - The transient adapter isn't a faithful reference: it keeps duplicate ids on
    insert and skips document loaders.
- **Inkeep** needs the most infrastructure: Doltgres can't move, and its run DB
  connection role is no longer a superuser after the move, so the cutover was
  rehearsed against a throwaway cluster first (plan step 11). Inkeep's migrations
  were fine as a non-superuser. **SpiceDB wasn't, at first:** its Postgres datastore
  decides visibility by transaction ID, so after a `pg_dump`/`pg_restore` onto a new
  server the restored relationships were invisible (their IDs were ahead of the new
  server's counter) until `spicedb datastore repair transaction-ids` ran. Anything
  that moves a SpiceDB Postgres datastore needs that step, and nothing errors without it.

### LangGraph.js 1.7.5

Logged 2026-11-22, while building it.

- **It's a library, not a server.** Everything around the graph is ours: the
  HTTP server, the SSE encoding, auth, one-run-per-thread locking, and
  deciding whether a message resumes a paused widget. The agent is about
  1,080 lines of TypeScript (excluding tests); about 250 of those are the
  server and encoder. The official Agent Server provides most of this, but
  self-hosting it needs Postgres, Redis and a LangSmith licence.
- **The browser SDK works against a custom server, with some reverse
  engineering.** `useStream` takes a custom `transport`, and its docs point at
  `toLangGraphEventStream` helpers that don't exist in these packages. What it
  expects, found by reading its source:
  - messages in the dict form `{...message.toDict().data, type}`, not the `lc`
    JSON that `graph.stream()` produces;
  - interrupts as a top-level `values` event `{__interrupt__: [...]}` (LangGraph
    does emit this);
  - no `metadata` event after the first event, or it starts a replay.
- **Interrupts are the best part.** A widget pauses the graph, and the guest's
  structured answer (`{type: 'interests', labels}`, `{type: 'confirm'}`)
  resumes it as the tool's result. The brief confirmation never goes back
  through the model as text, and the hand-off is a conditional edge. Two
  caveats:
  - a node that interrupts re-runs from the top on resume, and loses any state
    update it made before the pause, so the widget is prepared in an earlier
    node;
  - `useStream` resets its values at the start of every run, so the browser
    can't reliably tell whether the thread is paused after a Stop or an error.
    The server decides instead (`next` includes `awaitGuest`, or a task has an
    interrupt).
- **Message history is yours to keep valid.** LangGraph stores what the nodes
  return. A Stop during a search leaves a `tool_use` without a `tool_result`,
  and Anthropic then rejects every later turn. `repairHistory` inserts a
  "Cancelled" result right after the call before every model call. Appending it
  to state doesn't work: the guest's new message is already there by then.
- **Concurrent runs on one thread aren't serialised.** The server takes a
  per-thread lock; a run aborted by Stop is waited for (up to 5 s) rather than
  refused.
- **Small gotchas:** a node can't share a name with a state key (`intake` →
  `intakeAgent`).
- **Testing is pleasant.** A fake chat model is a short `BaseChatModel`
  subclass, and graph tests run the real graph with `MemorySaver`, including
  interrupts, resumes and aborts.
- **Sonnet 5.5 thinks by default** and rejects `thinking: {type: 'disabled'}`
  with "send `{type: 'between_tools'}` instead". With no option, 3 of 3
  tool-bound calls returned a thinking block; with `between_tools`, 0 of 3. The
  server strips thinking blocks before they reach the browser. This is the
  model, not LangGraph; Parlant can't turn thinking off on Claude 5.x either.
- **Persistence:** checkpoints go to SQLite (`better-sqlite3`, which installs
  from a prebuild on `node:26-alpine`). The writes are synchronous and block the
  event loop, which is fine at dev scale. Checkpoints hold the guest's details
  and full history, with no expiry. They also outlive the API's in-memory
  conversation record. Each claim gets a fresh thread id, so a reclaimed
  conversation id can't read an earlier guest's thread, but old threads
  linger, unreachable. Prune them before any prod use.
- **After Stop,** the partial reply stays on screen but isn't in the thread's
  history, so the model never sees it.
- **Web bundle:** the SDK plus LangChain's message classes come to 501 kB
  (132 kB gzipped). The LangGraph chat is lazy-loaded, so the other backends
  don't pay for it.
- **Debugging:** there's no trace UI without LangSmith. Inkeep has its visual
  builder's traces, and Parlant has its logs.

## Credentials and tool auth

Logged 2026-11-14, while adding web search. The current posture is accepted for
this project, but it is weaker than wanted. Weigh it when judging either
framework for work with more valuable credentials.

|                                      | Inkeep 0.80.4                                                                                                                                                                                              | Parlant 4.0.5                                                                                                                                                                                                                                                      | LangGraph.js 1.7.5                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| How a tool gets a secret             | Credential references (`credential()`) resolved by a credential store (memory/env, keychain, Nango) and injected into MCP requests by Inkeep's credential stuffer. Always sent as `Authorization: Bearer`. | None built in. Tool code reads env vars itself (`SearchClient`, `IntakeClient`).                                                                                                                                                                                   | None built in. Tool code reads env vars itself (`SearchClient`, `IntakeClient`), like Parlant.                                   |
| Secret kept out of config, DB and UI | Yes: the project definition stores only a reference.                                                                                                                                                       | Yes, but only because our code reads env.                                                                                                                                                                                                                          | Yes, because our code reads env. Checkpoints hold conversation state, not secrets.                                               |
| Secret kept out of the agent process | **No.** It sits in the Inkeep server's env and memory, the same process that runs the agent loop. The boundary is logical, not a process one.                                                              | **No.** It sits in Parlant's env, and our tool code reads it.                                                                                                                                                                                                      | **No.** It sits in the LangGraph server's env.                                                                                   |
| Authenticated MCP                    | Yes, through `mcpTool({ credential })`.                                                                                                                                                                    | **No.** `MCPToolClient` (`parlant/core/services/tools/mcp_service.py:178`) builds its FastMCP transport from a URL alone: no headers, no auth, and the path is fixed to `/mcp`. FastMCP itself supports `headers=` and `auth=`; Parlant doesn't pass them through. | Yes, through `@langchain/mcp-adapters` (2.0.3 takes custom `headers` or an auth provider). Not used here: search goes over REST. |
| Function tools and secrets           | `functionTool` runs in a sandbox with no clean way to receive one, so secrets push you to MCP.                                                                                                             | Native `@p.tool` functions are plain Python and can do anything, including reading secrets.                                                                                                                                                                        | LangChain `tool()` functions are plain TypeScript and can read anything.                                                         |

What this means here:

- **The model never sees a secret** on any backend.
- **The LangGraph service needs a token of its own.** The API sends it a Bearer
  `LANGGRAPH_API_TOKEN`. That's stricter than Parlant, which takes requests
  from anything in the cluster.
- **A compromised agent process could steal the tokens it holds**, on every
  backend. In this stack that's `SEARCH_API_TOKEN` and `INTAKE_API_TOKEN`:
  scoped, low-value tokens. Search is rate-capped and runs on a Tavily plan with
  a hard credit limit.
- **The valuable key never reaches any agent.** `TAVILY_API_KEY` lives only
  in the Nest API, which acts as a credential-injecting proxy: the agents can ask
  it to search, but can't take the key.
- **Parlant can't use an authenticated MCP server**, so a shared tool gateway
  would need a patch to `MCPToolClient._create_client`, network-level trust
  (in-cluster only, no token), a sidecar, or an upstream fix. Re-check on
  upgrades.
- **The stronger pattern** for valuable credentials is a credential-injecting
  proxy (a per-pod sidecar or a central gateway): the agent process never holds
  the secret, so it can use it only within the proxy's allowlist, and can't
  steal it. None of the three frameworks provides this. Each would have to sit
  behind one.

## Guest data and the model

Logged 2026-11-22. Nothing is handled yet beyond a prompt rule, but this is a
key trade-off between the frameworks. Here, "address" means the form of
address ("Dr Lima", or the full name). No postal address is collected.

**What reaches the model today.** Every backend sends the guest's real details
in the prompt, because the agent addresses them by name. Templates and
variables are filled in before the model call, so the model never sees a
placeholder.

|                            | Inkeep 0.80.4                                                             | Parlant 4.0.5                                                       | LangGraph.js 1.7.5                                                                               |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Guest fields in the prompt | `address`, `givenName`, destination, purpose, interests (context fetcher) | `address`, destination, purpose, interests (`guest_brief` variable) | `address`, `givenName`, destination, purpose, interests (`intakePrompt` / `plannerPrompt`)       |
| Guest's own messages       | Sent as typed                                                             | Sent as typed                                                       | Sent as typed                                                                                    |
| Where it's stored          | Inkeep's own database (conversation history)                              | Session events in SQLite under `PARLANT_HOME`                       | Checkpoints in SQLite, including the whole intake record (surname and title too), with no expiry |
| Back to the browser        | The reply stream                                                          | The session event stream                                            | The run stream; `values` events carry the whole graph state, intake record included              |

**Where each framework lets us intervene.** Two measures would cover most of
the risk:

- **Pseudonymize the name.** The model sees a placeholder such as `⟦GUEST⟧`,
  and the real name goes back in on the way to the browser.
- **Redact free text.** Run a PII detector, such as Microsoft Presidio or a
  guardrail model, over guest messages, which carry far more than the name.

|                                 | Inkeep                                                                                                                                                         | Parlant                                                                                      | LangGraph                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placeholder going in            | Easy: the API serves the context fetcher (`/api/intake/:id/context`), so it can return the placeholder.                                                        | Easy: the `guest_brief` tool reads the same API route.                                       | Easy: in our prompt functions, or in `loadIntake`.                                                                                                  |
| Real name going out             | Hard: the Nest proxy would rewrite Inkeep's AI SDK stream, where a placeholder can be split across chunks. Widgets come from the model, so they'd need it too. | Hard: the passthrough would rewrite message events as they grow; the same splitting problem. | Moderate: our server's SSE serializer can swap it before sending. A placeholder can still be split across message chunks, but we own the buffering. |
| Keeping the name out of storage | No: Inkeep stores the conversation itself.                                                                                                                     | Partly: depends on what Parlant persists for variables and tool results.                     | Yes: don't keep the real name in graph state, and pseudonymize before it's checkpointed.                                                            |
| Free-text redaction             | In the Nest proxy, before the message is forwarded (the API already builds the upstream body).                                                                 | In the Nest passthrough, before the message event is posted.                                 | In the Nest passthrough, or in the graph as a first node.                                                                                           |
| Search queries (to Tavily)      | In the API's search service: one place for all three.                                                                                                          | Same.                                                                                        | Same.                                                                                                                                               |

**What this means.**

- **The Nest API is the natural place for inbound guardrails.** Every guest
  message and every search query passes through it, so one free-text redaction
  covers all three frameworks.
- **Outbound is where the frameworks differ.** Putting the real name back,
  and keeping it out of storage, is natural in LangGraph, because we own the
  server and the state. In Inkeep and Parlant it means rewriting their streams
  from outside, and accepting what they store.
- **The cost of pseudonymizing:** the model loses whatever the name itself
  tells it, such as the language of a name or a formal address in another
  language. For greetings that's minor.
- **Measures that need no framework support:**
  - the provider's data terms: no training on API data by default, and zero
    data retention available;
  - pruning stored conversations;
  - keeping third-party tracing off.

## Comparing

Run the same script on every backend:

1. Give a destination, then a general purpose ("a relaxing getaway with my partner"). The interest picker should appear.
2. Pick interests. The brief should appear.
3. Edit a field in the app, then confirm with "Looks perfect".
4. Ask for an itinerary.
5. Press Stop during a turn.
6. Ask "Is anything special happening in Lisbon the second week of June next year?" The reply should link at least one source, say to confirm before booking, and show source chips. Then ask "What's the capital of Portugal?", which shouldn't search (no `search` line in the API log).

Note for each run:

- time to first text, and total time per turn;
- whether the agent asks one thing per message;
- whether widgets are well formed and appear at the right time;
- how reliable the hand-off is;
- the model calls per turn;
- the searches per turn, and whether the "Searching the web…" row appears;
- how easy each one was to author and debug;
- how each one handles the credentials its tools need (see above);
- where each one lets you keep guest data from the model and out of storage (see above).

## Eval log

Dated observations from running the comparison. Newest first.

### 2026-11-22: First LangGraph runs on the dev cluster

**Method.** A script played the comparison script through the API
(`/api/langgraph/:id/stream`): destination, a general purpose, interests,
an in-app edit of the purpose, confirm, "Could you sketch a three-day
itinerary?", the Lisbon events question with Stop pressed as the first search
started, the same question again at once, then "What's the capital of
Portugal?". It timed each turn from the request to the first agent text, and
the whole turn. Two runs after the fixes below; Sonnet 5.5 for both phases.

**Results (seconds: first text / whole turn).**

| Turn                          | Run A     | Run B      |
| ----------------------------- | --------- | ---------- |
| Destination                   | 1.2 / 1.3 | 1.9 / 2.0  |
| Purpose → interest picker     | 1.2 / 2.1 | 1.1 / 2.0  |
| Interests → trip brief        | 1.3 / 1.8 | 1.6 / 2.1  |
| Confirm → hand-off (planning) | 0.9 / 6.1 | 1.4 / 8.0  |
| Itinerary                     | 1.0 / 8.2 | 1.1 / 9.4  |
| Events question, after a Stop | 1.4 / 9.7 | 1.1 / 10.3 |
| Capital question (no search)  | 1.1 / 2.1 | 1.2 / 1.9  |

Before the hand-off fix, the confirm turn was 5.6 / 5.6 and 6.8 / 6.8: no
text until the whole reply arrived.

**Findings.**

- **Every step of the script passed.** The widgets appeared on the right
  turns, the planner used the purpose as edited in the app ("a slow, romantic
  anniversary trip"), Stop during a search was followed by a working turn (no
  409, no rejected history), the events answer linked its sources and said to
  confirm before booking, and the capital question didn't search.
- **One model call per turn**, two on a search turn. Search turns ran one to
  three searches, often two in parallel. The `custom` event arrived as each
  search started, so "Searching the web…" can show.
- **Time to first text is about 1–2 s on every turn.** That's well ahead of
  Parlant's ~3 s floor. Inkeep wasn't timed in this run. LangGraph adds no work before the
  reply beyond one intake API read.
- **Tokens per turn:** intake about 2.3–2.6k in and 30–150 out; planning
  1.7–2.5k in and 570–1,100 out; a search turn 9–10k in, mostly search results.
- **A reply right after a tool call isn't streamed** with Sonnet 5.5's
  `thinking: between_tools`. The API holds the text back until it's complete.
  - The hand-off was the visible case. It's fixed by showing the planner the
    intake's widget calls as text (`flattenToolCalls`) and adding the guest's
    answer as a guest message.
  - An answer that follows the planner's own search still arrives in one
    burst. The short line before the search ("Let me check what's on that
    week.") streams; the answer then lands about 8 s later. This is the
    model, so expect it on any framework that runs Claude 5.x with
    `between_tools`.
- **The intake model sometimes narrated its reasoning to the guest** ("The
  purpose is general, so I'll show the interest picker."), in about 1 turn in 5.
  Pinning the exact line for each widget in the prompt fixed it (4 of 4
  locally, and in the final run). Inkeep and Parlant get these lines from
  their own mechanisms (prompt wording, canned responses).
- **Deploys briefly break chat.** The LangGraph pod uses `Recreate` (its
  ReadWriteOnce volume can't be mounted twice), so a pod replacement leaves a
  few seconds with no pod and the API returns 502. Parlant has the same setup.
  Live-synced source edits restart the process in place and don't hit this.

### 2026-11-14: Parlant reply latency on the dev cluster

**Question.** Parlant turns feel like waiting for a whole reply, where
Inkeep's stream in. Can that be improved without changing what the agent says?

**Method.** A script played one conversation through the API (destination,
general purpose, interests, confirm, then "Could you sketch a three-day
itinerary?") and timed each turn from the guest's message to the first agent
text. It ran twice per setting, on the dev cluster with Voyage embeddings.

**Results (seconds to first text).**

| Turn                                | Intake at `high` (Sonnet) | Intake at `medium` (Haiku) |
| ----------------------------------- | ------------------------- | -------------------------- |
| Destination                         | 3.0, 3.2                  | 4.1, 3.3                   |
| Purpose → interest picker           | 4.3, 3.5                  | 4.3, 6.4                   |
| Interests → trip brief              | 4.5, 4.8                  | 4.3, 3.8                   |
| Confirm → hand-off (planning)       | 3.3, 3.5                  | 3.0, 3.3                   |
| Itinerary (planning, ~60–80 chunks) | 6.8, 6.8                  | 6.2, 6.4                   |

Planning ran at `high` in both columns. Widgets appeared on the same turns in
every run.

**Findings.**

- **Parlant does stream, but almost all of the wait comes before the first
  word.** Polling Parlant directly, a 78-chunk itinerary went from first chunk
  to complete in about 0.25 s, after 6.8 s with nothing to show. Short intake
  lines finish within one poll, so they look like blocks.
- **The reply model isn't the bottleneck.** Haiku (`medium`) was no faster
  than Sonnet (`high`) for intake. Every turn has a floor of about 3 s, even
  with no tool call. It goes to Parlant's work before the reply: rule
  matching, the `guest_brief` variable, embeddings, and thinking (which Parlant
  can't turn off on Claude 5.x). Parlant's default logs only time whole turns,
  so the split isn't measured yet.
- **Inkeep** makes one model call per turn and starts streaming almost at
  once. That gap is how Parlant works, not a setting.

**Changes.**

- Kept: intake and planning effort are now separate settings
  (`parlant.effort.intake` / `.planning` in Helm, `PARLANT_INTAKE_EFFORT` /
  `PARLANT_PLANNING_EFFORT`). Intake defaults back to `high`, since `medium`
  bought no speed. The planning policy raises turns to the planning effort.
- Kept: the Parlant chat shows what the agent is doing beside the spinner
  ("Thinking…", "Working on it…", or a tool's narration), from Parlant's
  `processing` status events. Reasoning text is never shown. Inkeep's chat is
  unchanged.
- Rejected: tool preambles ("Let me put that together…"). They would add
  lines the agent doesn't otherwise say.

**Follow-ups.**

- Measure the split before the first word, with Parlant's debug logs or
  tracing.
- Parlant's dev auth policy lets the API read the model's reasoning events,
  and the pass-through sends them to the browser. The UI never shows them, but
  they should be redacted (Parlant's production auth policy does this) or
  dropped in the API.
