# Observability: what your cluster needs

With `otel.enabled` (Tilt turns it on by default), every service sends traces
and metrics to the release's own collector, `<release>-alloy`. That collector
derives the LLM token metric and forwards everything to **your cluster's
collector**. This repo doesn't install a tracing or metrics stack. It assumes
your cluster already has one, and this page lists what that stack must provide.

```
api, langgraph, parlant, inkeep ──OTLP──▶ <release>-alloy ──OTLP/HTTP──▶ your collector ──▶ traces store
                                         (k8s.pod.ip,                                     ──▶ Prometheus
                                          token metric)                                   ──▶ Grafana
```

If you just want to try the app, run with OpenTelemetry off:
`tilt up -- --otel=off`, or `otel.enabled: false` in the chart values.

## Requirements

| Piece               | What it must do                                                                                                         | Where it's set                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A cluster collector | Accept OTLP/HTTP (traces **and** metrics on one base URL, `/v1/traces` and `/v1/metrics`), reachable from the namespace | `otel.upstreamEndpoint`; Tilt: `--otel-upstream=<url>` (default `http://alloy.monitoring.svc.cluster.local:4318`) |
| A traces store      | Tempo or any OTLP traces backend, fed by your collector                                                                 | your collector                                                                                                    |
| Prometheus          | Ingest OTLP metrics, directly or through your collector (see below)                                                     | your collector / Prometheus                                                                                       |
| Grafana             | A Prometheus data source, for the cost dashboard                                                                        | the dashboard's **ds** variable (default uid `prometheus`)                                                        |

## Prometheus and OTLP

The dashboard's queries expect the standard OTLP-to-Prometheus translation:

- Series are named like `travel_agent_search_requests_total` and
  `travel_agent_llm_tokens`, with attributes as labels
  (`gen_ai_token_type`, `client`, …).
- `job` is `<service.namespace>/<service.name>`, for example
  `travel-agent-dev/travel-agent-api`. That's how dev and prod stay apart,
  because the chart sets `service.namespace` to the namespace (`otel.environment`).

Prometheus' own OTLP receiver does this (`--web.enable-otlp-receiver`; in
kube-prometheus-stack, `prometheus.prometheusSpec.enableOTLPReceiver: true`).
Your collector then exports metrics to `http://<prometheus>:9090/api/v1/otlp`.
A collector that remote-writes to Prometheus works too, as long as it keeps the
same naming.

## Kubernetes metadata on spans (optional)

The release's collector stamps each span's resource with the sending pod's IP
(`k8s.pod.ip`), using `k8sattributes` in passthrough mode. If your collector
runs `k8sattributes`, it can then add the right pod, deployment and namespace,
not the release collector's. To make that explicit, match on the resource
attribute first:

```alloy
otelcol.processor.k8sattributes "default" {
  pod_association {
    source { from = "resource_attribute", name = "k8s.pod.ip" }
  }
  pod_association {
    source { from = "connection" }
  }
  // extract { metadata = [...] }, output { ... }
}
```

Without `k8sattributes`, everything still works; spans just lack those labels.

## A minimal cluster collector

If your cluster has Tempo and Prometheus but no collector yet, a single Grafana
Alloy (or OpenTelemetry Collector) like this is enough:

```alloy
otelcol.receiver.otlp "default" {
  http { endpoint = "0.0.0.0:4318" }
  output {
    traces  = [otelcol.processor.batch.default.input]
    metrics = [otelcol.processor.batch.default.input]
  }
}

otelcol.processor.batch "default" {
  output {
    traces  = [otelcol.exporter.otlp.tempo.input]
    metrics = [otelcol.exporter.otlphttp.prometheus.input]
  }
}

otelcol.exporter.otlp "tempo" {
  client {
    endpoint = "tempo.<namespace>:4317"
    tls { insecure = true }
  }
}

otelcol.exporter.otlphttp "prometheus" {
  client { endpoint = "http://<prometheus>.<namespace>:9090/api/v1/otlp" }
}
```

For a throwaway experiment without any of this, Grafana's all-in-one
`grafana/otel-lgtm` image (collector, Prometheus, Tempo, Loki and Grafana in one
container) can run in the cluster. Point `--otel-upstream` at its port 4318.

## The cost dashboard

The chart can ship the "Travel agent: cost by backend" dashboard as a ConfigMap
(`grafana.dashboard.enabled: true`, on one release only). Grafana loads it if its
dashboard sidecar watches every namespace for the `grafana_dashboard` label. In the
Grafana Helm chart that's `sidecar.dashboards.enabled: true`, `label: grafana_dashboard`
and `searchNamespace: ALL`. Otherwise, import
`deploy/helm/travel-agent/dashboards/travel-agent-costs.json` by hand.
`deploy/grafana/README.md` lists its panels.

## Network policies

If the namespace has egress policies, allow:

- the release collector (`app.kubernetes.io/component: alloy`) to reach your
  collector on its OTLP/HTTP port (4318);
- the LLM backends to reach their provider over HTTPS (`api.anthropic.com`),
  and the API to reach `api.tavily.com`.

Everything else stays inside the namespace. If the collector can't export,
nothing fails for users: telemetry is dropped, and the collector's logs say
"Exporting failed".

## What the release collector needs

- Alloy runs with `--stability.level=experimental`, but only in this release's
  collector, because the token rule (`otelcol.connector.signaltometrics`) is
  experimental in Alloy 1.21. Your own collector doesn't need the flag.
- It needs no Kubernetes API access (passthrough mode) and no RBAC.
- `deploy/alloy/test/token-rule.sh` tests the token rule locally with Docker.
