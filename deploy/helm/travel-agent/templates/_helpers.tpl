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
plus an optional "envFromSecret" naming a Secret whose keys all become env vars.
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
  selector:
    matchLabels:
      {{- include "travel-agent.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "travel-agent.labels" $root | nindent 8 }}
        app.kubernetes.io/component: {{ .component }}
    spec:
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
          {{- with $env }}
          env:
            {{- range $name, $value := . }}
            - name: {{ $name }}
              value: {{ $value | toString | quote }}
            {{- end }}
          {{- end }}
          # Generous startup window: dev images compile before serving.
          startupProbe:
            httpGet:
              path: {{ $v.healthPath }}
              port: http
            periodSeconds: 5
            failureThreshold: 60
          readinessProbe:
            httpGet:
              path: {{ $v.healthPath }}
              port: http
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: {{ $v.healthPath }}
              port: http
            periodSeconds: 20
          {{- with $v.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
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
