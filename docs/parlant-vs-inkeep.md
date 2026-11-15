# Parlant vs Inkeep

The same travel concierge is built twice, so the two agent frameworks can be
compared on one product:

- **Inkeep**: `apps/agents`, the existing agent with intake and planner sub-agents.
- **Parlant**: `apps/parlant`, Parlant 4.0.5 in Python, built the Parlant way.

Both sit behind the same web app and Nest API. The API's `CHAT_BACKEND`
(`inkeep` by default, or `parlant`) picks which one serves chat. The web app
reads it from `GET /api/config`.

## Running it

```sh
tilt up -- --chat-backend=parlant   # or inkeep, the default
```

Parlant runs in the dev namespace either way. The flag only changes which
backend the API talks to. Parlant's REST API is port-forwarded to
`localhost:8800`.

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

## What is shared, and what differs

The chat screen, the scripted opening (greeting, name and title), the widgets
(`IntakeComponents.tsx`) and the intake record in the API are shared. Each
backend has its own chat engine (`apps/web/src/chat/`) behind the same
`ChatEngine` interface.

|                        | Inkeep                                                                                                                                                                                   | Parlant                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire protocol          | AI SDK UI message stream from `POST /api/chat`. The API proxies Inkeep's stream.                                                                                                         | The session event log. The guest's message is posted as an event, and the reply arrives on an SSE stream of events that stays open. The API passes it through with ownership checks (`/api/parlant/:id/*`).                                                   |
| Streaming              | Tokens, through the AI SDK                                                                                                                                                               | Tokens. The message event grows in place, and each event is followed on its own stream until its `chunks` end in `null`.                                                                                                                                      |
| Status                 | None (status updates are off)                                                                                                                                                            | `acknowledged` / `processing` / `typing` / `ready` events. These drive the typing indicator.                                                                                                                                                                  |
| Structure              | Two sub-agents. The model decides when to transfer.                                                                                                                                      | One agent with rules. Intake and planning are gated in code on `briefConfirmed`, so the hand-off is deterministic.                                                                                                                                            |
| Widgets                | Data components that the model emits as part of its reply                                                                                                                                | Tool results. Observations attach the tools when the conversation calls for them, and the widget travels in `ToolResult.metadata`, which the model never sees.                                                                                                |
| Guest's details        | Context fetcher, templated into prompts                                                                                                                                                  | A `guest_brief` variable backed by a tool, refreshed every turn                                                                                                                                                                                               |
| Brief edits in the app | Described to the agent in a note added to the next message                                                                                                                               | Saved to the intake record (`PUT /api/intake/:id/draft`) before the message is sent. The agent reads the new brief from the variable.                                                                                                                         |
| Fixed lines            | Prompt wording                                                                                                                                                                           | Canned responses. In 4.0.5 these are style references, not enforced. See the findings below.                                                                                                                                                                  |
| Models                 | Haiku 5.5 for intake (data components need forced tool choice, which Sonnet 5.5 rejects) and Sonnet 5.5 for planning                                                                     | `Effort.HIGH`: Sonnet 5.5 for replies, Haiku 5.5 for rule matching and review                                                                                                                                                                                 |
| Web search             | An `mcpTool` on the planner, calling the API's MCP server (`POST /api/mcp`) with a Bearer token from Inkeep's memory credential store. The model sees the MCP server's tool description. | A `web_search` tool on the `trip-planning` policy, calling `POST /api/search/web` over REST (Parlant's MCP client can't send auth headers). It emits a `custom` event as it starts, so the app can show "Searching the web…" before the `tool` event arrives. |

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

## Credentials and tool auth

Logged 2026-11-14, while adding web search. The current posture is accepted for
this project, but it is weaker than wanted. Weigh it when judging either
framework for work with more valuable credentials.

|                                      | Inkeep 0.80.4                                                                                                                                                                                              | Parlant 4.0.5                                                                                                                                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| How a tool gets a secret             | Credential references (`credential()`) resolved by a credential store (memory/env, keychain, Nango) and injected into MCP requests by Inkeep's credential stuffer. Always sent as `Authorization: Bearer`. | None built in. Tool code reads env vars itself (`SearchClient`, `IntakeClient`).                                                                                                                                                                                   |
| Secret kept out of config, DB and UI | Yes: the project definition stores only a reference.                                                                                                                                                       | Yes, but only because our code reads env.                                                                                                                                                                                                                          |
| Secret kept out of the agent process | **No.** It sits in the Inkeep server's env and memory, the same process that runs the agent loop. The boundary is logical, not a process one.                                                              | **No.** It sits in Parlant's env, and our tool code reads it.                                                                                                                                                                                                      |
| Authenticated MCP                    | Yes, through `mcpTool({ credential })`.                                                                                                                                                                    | **No.** `MCPToolClient` (`parlant/core/services/tools/mcp_service.py:178`) builds its FastMCP transport from a URL alone: no headers, no auth, and the path is fixed to `/mcp`. FastMCP itself supports `headers=` and `auth=`; Parlant doesn't pass them through. |
| Function tools and secrets           | `functionTool` runs in a sandbox with no clean way to receive one, so secrets push you to MCP.                                                                                                             | Native `@p.tool` functions are plain Python and can do anything, including reading secrets.                                                                                                                                                                        |

What this means here:

- **The model never sees a secret** on either backend.
- **A compromised agent process could steal the tokens it holds**, on both
  backends. In this stack that's `SEARCH_API_TOKEN` and `INTAKE_API_TOKEN`:
  scoped, low-value tokens. Search is rate-capped and runs on a Tavily plan with
  a hard credit limit.
- **The valuable key never reaches either agent.** `TAVILY_API_KEY` lives only
  in the Nest API, which acts as a credential-injecting proxy: the agents can ask
  it to search, but can't take the key.
- **Parlant can't use an authenticated MCP server**, so a shared tool gateway
  would need a patch to `MCPToolClient._create_client`, network-level trust
  (in-cluster only, no token), a sidecar, or an upstream fix. Re-check on
  upgrades.
- **The stronger pattern** for valuable credentials is a credential-injecting
  proxy (a per-pod sidecar or a central gateway): the agent process never holds
  the secret, so it can use it only within the proxy's allowlist, and can't
  steal it. Neither framework provides this. Both would have to sit behind one.

## Comparing

Run the same script on both backends:

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
- how each one handles the credentials its tools need (see above).

## Eval log

Dated observations from running the comparison. Newest first.

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
