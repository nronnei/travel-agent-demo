# Grafana: travel agent cost dashboard

`deploy/helm/travel-agent/dashboards/travel-agent-costs.json` is the source of truth
for the **"Travel agent: cost by backend"** dashboard (uid `travel-agent-costs`). The
chart ships it as a ConfigMap (`grafana.dashboard.enabled`), which Grafana's dashboard
sidecar loads into the "Travel agent" folder. Edit the JSON here, not in the Grafana UI:
the next deploy overwrites UI edits.

## What it shows

Per chat backend (Inkeep, Parlant, LangGraph), over the selected time range, for the
environment picked in **Environment** (`$ns`: `travel-agent` or `travel-agent-dev`):

| Panel                                                        | Source                                               |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| Cost by backend (table, one row per backend, zeros included) | input/output tokens, Tavily credits, searches        |
| Tokens by backend and type                                   | `travel_agent_llm_tokens`                            |
| Tokens over time by backend and model                        | `travel_agent_llm_tokens` by `gen_ai_response_model` |
| Tavily credits over time                                     | `travel_agent_search_credits_total` (a lower bound)  |
| Searches by backend and outcome                              | `travel_agent_search_requests_total`                 |
| Search cache hit ratio                                       | cached ÷ (ok + cached)                               |

Units are tokens and credits; there are no USD figures.

## Where the numbers come from

- **`travel_agent_llm_tokens`** (labels `gen_ai_token_type` = `input`|`output`,
  `gen_ai_response_model`, `gen_ai_provider_name`; `job` = `<ns>/travel-agent-<backend>`)
  is derived by each release's own Alloy collector (`templates/alloy.yaml`) from the
  backends' `gen_ai` spans. `input` includes cache reads and writes. It lands in
  Prometheus without a `_total` suffix (the collector's sums aren't marked monotonic);
  `increase()` works on it.
- **`travel_agent_search_requests_total`** (`client`, `outcome`) and
  **`travel_agent_search_credits_total`** (`client`) come from the API
  (`apps/api/src/search/search.metrics.ts`); `job` = `<ns>/travel-agent-api`.

## Caveats

- Totals over a range are approximate: `increase()` extrapolates at the range edges,
  and a brand-new series (a new model, or the first data after a collector or API
  restart for tokens) loses its first data point. The search counters start every
  series at 0 to avoid that; the token series can't, since models aren't known ahead.
- Tavily credits are a lower bound: a timed-out search may still be billed.
- Search rate and daily limits are shared by all backends.

## Setup

1. Prometheus data source with uid `prometheus` (the `ds` variable picks it; change it
   there if yours differs).
2. `grafana.dashboard.enabled: true` on one release (the homelab prod values), and a
   Grafana whose dashboard sidecar watches every namespace for the `grafana_dashboard`
   label. Or import the JSON by hand: Dashboards → New → Import.
