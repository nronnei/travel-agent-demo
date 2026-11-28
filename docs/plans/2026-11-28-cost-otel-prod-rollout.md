---
title: Prod rollout of cost attribution, OTEL and the in-chart Inkeep
status: draft
revision: 1
updated: 2026-11-28
reviewed: none
issue:
artifact: https://claude.ai/artifact/11dwmdajbCADsusWDXimD6
---

# Prod rollout of cost attribution, OTEL and the in-chart Inkeep

## Summary
`feat/cost-attribution-otel` (plan `2026-11-22-per-backend-cost-attribution.md`) is built and verified under Tilt, and PR #6 put Inkeep in the chart. Prod (`travel-agent` namespace) still runs with OTEL off and talks to the homelab Inkeep. This plan takes prod there in two phases, OTEL first and the Inkeep cutover second, and lists every homelab change in one place:
- the prod network policy (the collector's egress to the central Alloy, Inkeep's egress to Anthropic);
- the homelab values (`otel.*`, then `inkeep.server.*`);
- the dashboard, shipped by the chart as a `grafana_dashboard` ConfigMap, so nothing is provisioned by hand;
- the prod Inkeep secrets and agent push;
- retiring the homelab Inkeep after a soak.

A monitoring prompt for an agent to watch the rollout (memory especially) is in the appendix.

## Goals
- Prod exports traces and metrics through `travel-agent-alloy` to the central Alloy, under `service.namespace=travel-agent`, and the dashboard's **Environment = travel-agent** shows data.
- The prod chat backend runs on the in-chart Inkeep, with agents pushed from `apps/agents`, web search over MCP and the intake context working.
- Nothing in the namespace can reach more than before, except: the collector pod to `monitoring/alloy:4318`, and the namespace's pods to `api.anthropic.com:443`. After the cutover, the egress to the `inkeep` namespace is removed.
- The dashboard appears in Grafana without hand provisioning, from the chart.
- Memory, restarts and export health are watched through both phases (appendix prompt), against these bars: working set under 80% of each limit, no OOM kills, no sustained exporter failures.

## Non-goals
- Enabling Parlant or LangGraph in prod (prod's `chat.backend` stays `inkeep`). LangGraph's runtime-image RSS is measured separately (follow-up) before it's ever enabled in prod.
- Migrating the homelab Inkeep's data (decided rev 15 of the parent plan).
- Tail sampling, the Bedrock token rule, the Prometheus first-sample fix (accepted as is).

## Context
- **Prod network policy** (`homelab/apps/travel-agent/network-policy.yaml`, `travel-agent-policy`, `endpointSelector: {}`): ingress from Cilium ingress/host, cloudflared and the namespace; egress to the namespace, kube-dns (DNS proxy), `inkeep` api:3002, and `api.tavily.com:443` by FQDN. No egress to `monitoring` or to Anthropic. Its comment already says a backend calling an LLM provider needs its hostname added.
- **DB policy** (`postgres-network-policy.yaml`) selects only the CNPG pods; app pods reach them through the namespace-wide rule, so Inkeep's roles need nothing new.
- **Monitoring namespace:** the only policy (`alloy-syslog-no-pods`) denies pod ingress to Alloy's syslog port 5140; OTLP 4318 is open.
- **Outbound hosts seen in dev traces:** the in-chart Inkeep called only `api.anthropic.com` and the travel-agent API; Parlant and LangGraph call `api.anthropic.com` too; the API calls `api.tavily.com`.
- **Grafana** (`homelab/helm-values/grafana.yaml`) loads dashboards from any ConfigMap labelled `grafana_dashboard` in any namespace, with a `grafana_folder` annotation.
- **Homelab values** (`helm-values/travel-agent.yaml`): `inkeep.apiUrl: http://inkeep-api.inkeep:3002`, `inkeep.existingSecret: travel-agent-inkeep`, `postgres` on (`longhorn-workers`), no `otel` block.
- **Deploy:** `npm run deploy` (`scripts/deploy.sh`) publishes the chart and runtime images, then `helm upgrade --install … -f helm-values/travel-agent.yaml --wait`.
- **The homelab Inkeep** (`inkeep` namespace: app-template release, `inkeep-db` CNPG cluster, Doltgres PVC, `inkeep-secrets`) stays untouched until step 7.

## Assumptions
- The Cilium DNS proxy already used for `api.tavily.com` works the same for `api.anthropic.com`.
- The project Alloy pod keeps the chart's `app.kubernetes.io/component: alloy` label, so a policy can select it.
- The dashboard JSON (≈400 lines) fits a ConfigMap easily.
- The prod API Secret `travel-agent-inkeep` holds `SEARCH_API_TOKEN` and `INTAKE_API_TOKEN` (the secrets script copies them from there).

## Design

### Dashboard from the chart
- Move `deploy/grafana/travel-agent-costs.json` to `deploy/helm/travel-agent/dashboards/travel-agent-costs.json` (Helm can only read files inside the chart), and keep `deploy/grafana/README.md` pointing at it.
- New `templates/grafana-dashboard.yaml`: when `grafana.dashboard.enabled` (default false; the homelab values turn it on), a ConfigMap `<release>-dashboard` labelled `grafana_dashboard: "1"`, annotated `grafana_folder: Travel agent`, holding the JSON via `.Files.Get`.
- Only the prod release turns it on; the dev release (Tilt) doesn't, so the two don't fight over uid `travel-agent-costs`. The dashboard's `ns` variable covers both environments.

### Network policy (homelab repo)
- In `travel-agent-policy`'s FQDN rule, add `api.anthropic.com` next to `api.tavily.com` (443/TCP). Every pod in the namespace gets it, as with Tavily; that also covers Parlant or LangGraph if they're ever enabled.
- A new, separate `CiliumNetworkPolicy` `travel-agent-otel` selecting only `app.kubernetes.io/component: alloy`, with egress to `monitoring` / `app.kubernetes.io/name: alloy` on 4318/TCP. A separate policy so the grant can't widen to the other pods.
- After the cutover (step 6), remove the egress rule to the `inkeep` namespace.

### Phases
- **Phase A (OTEL only):** netpol, `otel.*` values, deploy. Chat still uses the homelab Inkeep. Low risk: OTEL can be turned off with one value.
- **Phase B (Inkeep cutover):** prod Inkeep secrets, `inkeep.server.*` values, deploy, push, smoke, credential scan. Rollback is one value flip back to `inkeep.apiUrl`.
- **Retire** the homelab Inkeep after a soak.

### Alternatives considered
| Option | Pros | Cons | Why not |
|---|---|---|---|
| Dashboard provisioned from the homelab repo | Grafana config stays in one repo | A manual copy every time the JSON changes; drift | The sidecar already reads labelled ConfigMaps from any namespace |
| One phase (OTEL and Inkeep together) | One deploy | Two independent risks in one rollback | Phases keep each rollback to one value |
| Anthropic egress only for the Inkeep pods | Narrowest grant | A separate policy per backend; Parlant/LangGraph need it too when enabled | The policy's own comment says to add LLM hostnames to the shared list |

## Implementation steps

### 1. Dashboard ConfigMap in the chart (this repo, on the cost branch)
- **Files:** `deploy/helm/travel-agent/dashboards/travel-agent-costs.json` (moved), `templates/grafana-dashboard.yaml` (new), `values.yaml` (`grafana.dashboard.enabled: false`, `grafana.dashboard.folder: Travel agent`), `deploy/grafana/README.md` (new location, enabling it), `docs/agent-frameworks.md` (setup checklist).
- **Verify:** `helm template` renders no ConfigMap by default, and one with the label, annotation and valid JSON with `grafana.dashboard.enabled=true`; `helm lint` passes.

### 2. Open and merge the cost PR
- Push `feat/cost-attribution-otel`, open the PR (plan, verification and open items in the body), merge after review.
- **Verify:** CI green; `main` contains the collector, token rule, dashboard ConfigMap and docs.

### 3. Homelab: network policy (homelab repo PR, applied before step 4)
- **Files:** `apps/travel-agent/network-policy.yaml` (add `api.anthropic.com`), `apps/travel-agent/otel-network-policy.yaml` (new `travel-agent-otel`), `apps/travel-agent/kustomization.yaml` (include it).
- **Apply:** `kubectl apply -k apps/travel-agent`.
- **Verify:** both policies show `Valid`; prod keeps serving (a chat turn on the homelab Inkeep still works).

### 4. Phase A: OTEL on in prod
- **Homelab values** (`helm-values/travel-agent.yaml`): `otel.enabled: true`, `otel.upstreamEndpoint: http://alloy.monitoring.svc.cluster.local:4318`, `otel.environment: prod`, `grafana.dashboard.enabled: true`.
- **Deploy:** `npm run deploy` from `main`.
- **Start the monitoring agent** (appendix prompt) as soon as the deploy finishes.
- **Verify:**
  - `travel-agent-alloy` is Running; its logs show no export failures.
  - Tempo has `travel-agent-api` (and the web's calls through it) under `service.namespace=travel-agent`, tagged with the app's own `k8s.deployment.name`.
  - Prometheus has `travel_agent_search_requests_total{job="travel-agent/travel-agent-api"}` with all `client × outcome` series at 0 or more.
  - `hubble observe -n travel-agent --verdict DROPPED` shows nothing new, in particular nothing to `monitoring`.
  - The dashboard appears in Grafana's "Travel agent" folder.
  - A guest chat turn (still on the homelab Inkeep) works.

### 5. Phase B prep: prod Inkeep secrets
- `ANTHROPIC_API_KEY=… ADMIN_EMAIL=… scripts/inkeep-secrets.sh prod` (creates `travel-agent-inkeep-server`, `travel-agent-db-inkeep`, `travel-agent-db-spicedb`; copies the two tokens from `travel-agent-inkeep`; refuses to overwrite).
- **Verify:** the three Secrets exist; the script printed the admin login.

### 6. Phase B: Inkeep cutover
- **Homelab values:** `inkeep.apiUrl: ''`, `inkeep.server.enabled: true`, `inkeep.server.secret: travel-agent-inkeep-server`, `inkeep.server.doltgres.storage.storageClassName: longhorn-workers`, `inkeep.server.api.publicUrl` / `manageUiUrl` (what the manage UI uses; without an ingress for it, set them to the port-forward URLs used for pushes), and the node selector already applies.
- **Deploy:** `npm run deploy`.
- **Push:** `kubectl -n travel-agent port-forward svc/travel-agent-inkeep-api 3002` and `kubectl -n travel-agent port-forward svc/travel-agent-inkeep-ui 3003:3000`, then `INKEEP_API=http://localhost:3002 INKEEP_UI=http://localhost:3003 INKEEP_SECRET=travel-agent/travel-agent-inkeep-server scripts/push-agents.sh prod`.
- **Smoke:** a guest conversation that gives a destination, has its brief confirmed, and asks for events, so the planner runs a web search over MCP and the intake context is fetched (A26 of the parent plan).
- **Verify:**
  - every Inkeep pod Running; migrations ran; push succeeded;
  - the smoke turn's API log shows `search ok client=inkeep`, and Prometheus shows `travel_agent_llm_tokens{job="travel-agent/travel-agent-inkeep"}` by model;
  - the `inkeep` and `spicedb` roles connect over TLS (`pg_stat_ssl`);
  - `hubble observe -n travel-agent --verdict DROPPED` shows no drops (Inkeep reaching anything besides Anthropic would show here);
  - a credential pattern scan over the prod Inkeep spans from the smoke window finds nothing (the parent plan's step 7 scan).
- **Then:** remove the `inkeep` namespace egress from `travel-agent-policy` and re-apply.

### 7. Retire the homelab Inkeep (after a soak)
- After the soak (open question 2), with the user's go-ahead:
  - one Longhorn backup of the Doltgres PVC and the `inkeep-db` volume, kept until the deletion is confirmed fine (project practice: the homelab isn't prod, so one backup, deleted after);
  - `helm uninstall inkeep -n inkeep`, delete `inkeep-db` (CNPG), the PVCs, `inkeep-secrets` and the namespace;
  - remove `apps/inkeep`, `helm-values/inkeep.yaml` and `scripts/generate-inkeep-secret.sh` from the homelab repo.
- **Verify:** prod chat still works; nothing in the cluster references `inkeep-api.inkeep`.

## Test plan
- `helm template` / `helm lint` for the dashboard ConfigMap (step 1).
- The phase A and phase B verification lists, run by hand.
- The appendix monitoring prompt, run by an agent from the start of phase A to the end of the soak.

## Rollout & rollback
- **Order:** steps 1 → 7 as numbered; phase B only after phase A has run clean for at least a day of normal traffic.
- **Rollback:**
  - Phase A: `otel.enabled: false` (and `grafana.dashboard.enabled: false` if needed), deploy. The netpol additions can stay; they grant only the collector's egress and Anthropic.
  - Phase B: `inkeep.server.enabled: false`, `inkeep.apiUrl: http://inkeep-api.inkeep:3002`, deploy; restore the `inkeep` egress rule first if it was already removed. The in-chart Inkeep's PVC and databases stay (`retain`).
  - If a credential appears in telemetry: OTEL off for that service, rotate it, purge or record (as the parent plan).

## Security considerations
- The two new egress grants are narrow: one pod (the collector) to one port on one service, and one public hostname over TLS.
- The prod Inkeep Secret holds auth, JWT and bypass secrets; it's created from memory by the script (values never on argv or disk) and lives only in the `travel-agent` namespace. Its manage UI has no ingress; pushes use a port-forward.
- Guest data in traces (Inkeep's AI SDK content attributes, Parlant's reply events) stays under the parent plan's accepted risk; with Inkeep in this namespace, its telemetry holds only this app's conversations.
- Removing the `inkeep` namespace egress after cutover shrinks the policy back.

## Performance considerations
- Prod runs the API, web, the collector and (phase B) Inkeep's four pods. Inkeep's limits add up to about 5.5 GiB and its requests to about 0.8 GiB; check the amd64 nodes have room before phase B (`kubectl describe nodes` allocated resources).
- Memory is the open bar from the parent plan: the appendix prompt watches working set against limits for every container, from the runtime images.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The netpol blocks the collector or Anthropic | Medium | No prod telemetry, or Inkeep can't answer | Step 3 before step 4; hubble checks in steps 4 and 6 |
| Inkeep calls a host the policy doesn't allow | Low (dev showed only Anthropic) | Some Inkeep feature fails | hubble drops in step 6; add the hostname |
| Prod nodes lack room for Inkeep | Medium | Pending pods | Check allocatable before step 6 |
| Memory over the limit on runtime images | Medium | OOM kills | Appendix monitoring; raise limits or use the allow-list fallback |
| Dashboard uid clash between releases | Low | One overwrites the other | Only the prod release ships the ConfigMap |
| Push fails (tool discovery needs the API) | Low | No agents in the new Inkeep | Push after the API and Inkeep are Ready; rerun |
| Cutover drops in-flight conversations | Certain (by choice) | Old threads not in the new Inkeep | Accepted (no migration); homelab Inkeep kept until retirement |

## Open questions
1. **Ship the dashboard from the chart (ConfigMap) rather than the homelab repo?** Recommended: yes (step 1).
2. **Soak length before retiring the homelab Inkeep?** Recommended: one week of normal use with the monitoring clean.

## Follow-ups
- Measure LangGraph's and Parlant's RSS on the runtime images (a one-off prod-like deploy with `langgraph.enabled`) before either is enabled in prod.
- A manage-UI ingress for the prod Inkeep, if editing agents in the UI becomes useful.

## Decision log
- rev 1: two phases (drafter); dashboard from the chart (drafter, open question 1); Anthropic in the shared FQDN list, the collector's egress in its own policy (drafter).

## Changelog
- rev 1: initial draft.

## Appendix: rollout monitoring prompt

Give this to an agent (Claude Code with the Grafana MCP and `kubectl` read access) at the start of phase A. It only reads and reports.

```text
You are monitoring a production rollout of the travel-agent app on a homelab
Kubernetes cluster. Do not change anything: no kubectl apply/edit/delete/scale/
rollout, no Grafana writes. Read and report only. If something needs action,
say what and why, and stop.

Scope: namespace "travel-agent". Components (label app.kubernetes.io/component):
api, web, alloy (the release's own OTEL collector), and after the Inkeep cutover
inkeep-api, inkeep-ui, inkeep-spicedb, inkeep-doltgres. Prometheus datasource
uid "prometheus", Tempo uid "tempo".

Every 30 minutes for the next 24 hours (then every 2 hours until told to stop),
check and record:

1. Memory against limits, per container (the main open risk):
   max by (pod, container) (container_memory_working_set_bytes{namespace="travel-agent", container!="", container!="POD"})
   / on (pod, container) group_left max by (pod, container) (kube_pod_container_resource_limits{namespace="travel-agent", resource="memory"})
   Also the peak over the window with max_over_time(...[30m]).
   Flag: WARN at > 0.80, URGENT at > 0.90 or if the ratio climbs steadily
   across three checks (a leak).
2. Restarts and OOM kills:
   increase(kube_pod_container_status_restarts_total{namespace="travel-agent"}[30m])
   kube_pod_container_status_last_terminated_reason{namespace="travel-agent", reason="OOMKilled"}
   Flag: URGENT on any OOMKilled; WARN on any restart.
3. Telemetry export health (the release collector):
   increase(otelcol_exporter_send_failed_spans_total{namespace="travel-agent"}[30m]),
   increase(otelcol_exporter_send_failed_metric_points_total{namespace="travel-agent"}[30m]),
   or, if those series don't exist, `kubectl -n travel-agent logs deploy/travel-agent-alloy --since=30m`
   filtered for "level=error" or "Exporting failed".
   Flag: WARN if failures persist across two checks.
4. Data is arriving:
   count by (job) ({job=~"travel-agent/.*"}) in Prometheus is non-zero for
   travel-agent/travel-agent-api (and travel-agent/travel-agent-inkeep after
   the cutover); a TraceQL search { resource.service.namespace = "travel-agent" }
   over the last 30 minutes returns traces whose resource k8s.deployment.name is
   the app's own deployment, never travel-agent-alloy.
5. Latency of the API (no SLO, watch for jumps against the first day's values):
   histogram_quantile(0.99, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket{job="travel-agent/travel-agent-api"}[30m])))
6. Network drops, if you have shell access to the cluster:
   hubble observe -n travel-agent --verdict DROPPED --since 30m
   Flag: WARN on anything new, with the destination.

Report each check as a short table (component, value, status). Put WARN and
URGENT findings first, with the query, the value, and the likely cause. At the
end of the first 24 hours, write a summary: peak memory ratio per container,
restarts, export failures, and whether the parent plan's memory bar (working
set under 80% of the limit) held.
```
