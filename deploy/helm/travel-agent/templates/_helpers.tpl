{{- define "travel-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "travel-agent.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "travel-agent.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "travel-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Expects (dict "root" $ "component" "api") */}}
{{- define "travel-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "travel-agent.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/* Expects (dict "root" $ "component" "api") */}}
{{- define "travel-agent.componentName" -}}
{{- printf "%s-%s" (include "travel-agent.fullname" .root) .component | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Deployment shared by every component.
Expects (dict "root" $ "component" "api" "values" .Values.api "env" (dict ...)),
plus an optional "envFromSecret" naming a Secret whose keys all become env vars,
optional "volumes" / "volumeMounts" lists, an optional "secretEnv" list of
(dict "name" "ENV_VAR" "secret" "secret-name" "key" "key"), and an optional "strategy" (the
Deployment's rollout strategy, e.g. Recreate for a ReadWriteOnce volume), and an optional
"initContainers" list (rendered as given).
.values.podSecurityContext, if set, becomes the pod's securityContext.
.values.probe, if set, replaces the httpGet on .values.healthPath in all three probes
(e.g. tcpSocket: {port: http}).
Entries in .values.env override the computed "env".
*/}}
{{- define "travel-agent.deployment" -}}
{{- $root := .root -}}
{{- $v := .values -}}
{{- $env := merge (dict) ($v.env | default dict) (.env | default dict) -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "travel-agent.componentName" . }}
  labels:
    {{- include "travel-agent.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  replicas: {{ $v.replicas }}
  {{- with .strategy }}
  strategy:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "travel-agent.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "travel-agent.labels" $root | nindent 8 }}
        app.kubernetes.io/component: {{ .component }}
    spec:
      {{- with $v.podSecurityContext }}
      securityContext:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $root.Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $root.Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $root.Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $root.Values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .initContainers }}
      initContainers:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: {{ .component }}
          image: "{{ $v.image.repository }}:{{ $v.image.tag | default $root.Chart.AppVersion }}"
          imagePullPolicy: {{ $v.image.pullPolicy }}
          {{- with $v.securityContext }}
          securityContext:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          ports:
            - name: http
              containerPort: {{ $v.containerPort }}
          {{- with .envFromSecret }}
          envFrom:
            - secretRef:
                name: {{ . }}
          {{- end }}
          {{- if or .secretEnv $env }}
          env:
            {{- /* Secret entries first, so literal values can expand them with $(VAR). */ -}}
            {{- range .secretEnv }}
            - name: {{ .name }}
              valueFrom:
                secretKeyRef:
                  name: {{ .secret }}
                  key: {{ .key }}
            {{- end }}
            {{- range $name, $value := $env }}
            - name: {{ $name }}
              value: {{ $value | toString | quote }}
            {{- end }}
          {{- end }}
          # Generous startup window: dev images compile before serving.
          {{- $probe := $v.probe | default (dict "httpGet" (dict "path" $v.healthPath "port" "http")) }}
          startupProbe:
            {{- toYaml $probe | nindent 12 }}
            periodSeconds: 5
            failureThreshold: 60
          readinessProbe:
            {{- toYaml $probe | nindent 12 }}
            periodSeconds: 10
          livenessProbe:
            {{- toYaml $probe | nindent 12 }}
            periodSeconds: 20
          {{- with $v.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with .volumeMounts }}
          volumeMounts:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      {{- with .volumes }}
      volumes:
        {{- toYaml . | nindent 8 }}
      {{- end }}
{{- end }}

{{/* Expects (dict "root" $ "component" "api" "values" .Values.api) */}}
{{- define "travel-agent.service" -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "travel-agent.componentName" . }}
  labels:
    {{- include "travel-agent.labels" .root | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  type: ClusterIP
  selector:
    {{- include "travel-agent.selectorLabels" . | nindent 4 }}
  ports:
    - name: http
      port: {{ .values.service.port }}
      targetPort: http
{{- end }}

{{/* The environment's CNPG cluster (templates/postgres.yaml). Expects the root context. */}}
{{- define "travel-agent.postgresClusterName" -}}
{{- printf "%s-db" (include "travel-agent.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Connection settings for a backend's own database in the cluster: its role's password
from the basic-auth Secret, a URL built from it, and the cluster CA for verifying the
server. Expects (dict "root" $ "component" "langgraph" "prefix" "LANGGRAPH_"), plus an
optional "urlName" (the URL's env var; default <prefix>DATABASE_URL) and "query" (appended
to the URL, e.g. "sslmode=verify-full&sslrootcert=/etc/postgres-ca/ca.crt" for clients
that don't read <prefix>DATABASE_SSL_ROOT_CERT); returns YAML with "secretEnv", "env",
"volume" and "mount", for fromYaml.
The API instead reads the operator's <cluster>-app Secret (templates/api.yaml).
*/}}
{{- define "travel-agent.postgresConnection" -}}
{{- $cluster := include "travel-agent.postgresClusterName" .root -}}
{{- $password := printf "%sDB_PASSWORD" .prefix -}}
secretEnv:
  - name: {{ $password }}
    secret: {{ printf "%s-%s" $cluster .component }}
    key: password
env:
  {{ .urlName | default (printf "%sDATABASE_URL" .prefix) }}: {{ printf "postgresql://%s:$(%s)@%s-rw:5432/%s%s" .component $password $cluster .component (ternary (printf "?%s" .query) "" (not (empty .query))) | quote }}
  {{ .prefix }}DATABASE_SSL_ROOT_CERT: /etc/postgres-ca/ca.crt
{{ include "travel-agent.postgresCaMounts" .root }}
{{- end }}

{{/* The cluster CA volume and its mount, as YAML "volume" and "mount" keys. Expects the root context. */}}
{{- define "travel-agent.postgresCaMounts" -}}
volume:
  name: postgres-ca
  secret:
    secretName: {{ include "travel-agent.postgresClusterName" . }}-ca
    items:
      - key: ca.crt
        path: ca.crt
mount:
  name: postgres-ca
  mountPath: /etc/postgres-ca
  readOnly: true
{{- end }}

{{/*
OpenTelemetry env for one service, set into the given $env dict when
otel.enabled. Values-level `<component>.env` entries are merged later in
travel-agent.deployment and win.
Usage: {{- $_ := include "travel-agent.otelEnv" (dict "root" . "env" $env "service" "travel-agent-api" "runtime" "node") -}}
*/}}
{{- define "travel-agent.otelEnv" -}}
{{- $o := .root.Values.otel -}}
{{- if $o.enabled -}}
{{- if not $o.endpoint -}}{{- fail "otel.enabled needs otel.endpoint" -}}{{- end -}}
{{- $ns := ternary "travel-agent" "travel-agent-dev" (eq $o.environment "prod") -}}
{{- $env := .env -}}
{{- $_ := set $env "OTEL_SERVICE_NAME" .service -}}
{{- $_ := set $env "OTEL_RESOURCE_ATTRIBUTES" (printf "service.namespace=%s,deployment.environment.name=%s" $ns $o.environment) -}}
{{- $_ := set $env "OTEL_EXPORTER_OTLP_PROTOCOL" "http/protobuf" -}}
{{- $_ := set $env "OTEL_PROPAGATORS" "tracecontext" -}}
{{- $_ := set $env "OTEL_TRACES_SAMPLER" $o.tracesSampler -}}
{{- $_ := set $env "OTEL_METRIC_EXPORT_INTERVAL" (toString $o.metricExportIntervalMs) -}}
{{- if eq .runtime "node" -}}
{{- $_ := set $env "OTEL_EXPORTER_OTLP_ENDPOINT" $o.endpoint -}}
{{- $_ := set $env "OTEL_TRACES_EXPORTER" "otlp" -}}
{{- $_ := set $env "OTEL_METRICS_EXPORTER" "otlp" -}}
{{- $_ := set $env "OTEL_LOGS_EXPORTER" "none" -}}
{{- $_ := set $env "OTEL_NODE_DISABLED_INSTRUMENTATIONS" "nestjs-core,dns,net" -}}
{{- else -}}
{{- $_ := set $env "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" (printf "%s/v1/traces" (trimSuffix "/" $o.endpoint)) -}}
{{- $_ := set $env "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT" (printf "%s/v1/metrics" (trimSuffix "/" $o.endpoint)) -}}
{{- $_ := set $env "TRACELOOP_TRACE_CONTENT" "false" -}}
{{- end -}}
{{- end -}}
{{- end -}}
