{{/*
sigrun chart helpers — standard idioms (mirrors the searxng/hermes chart
conventions: name/fullname/chart/labels/selectorLabels/componentLabels).
*/}}
{{- define "sigrun.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "sigrun.fullname" -}}
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

{{- define "sigrun.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "sigrun.labels" -}}
helm.sh/chart: {{ include "sigrun.chart" . }}
{{ include "sigrun.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "sigrun.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sigrun.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Component labels: selectorLabels + app.kubernetes.io/component: <component>.
Usage: include "sigrun.componentLabels" (dict "Chart" .Chart "Values" .Values
"Release" .Release "component" "server").
*/}}
{{- define "sigrun.componentLabels" -}}
{{ include "sigrun.selectorLabels" . }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
PVC full name: <fullname>-<persistence.name> (unique per release so two
releases can coexist in one namespace without volume-name collisions).
*/}}
{{- define "sigrun.dataPVCName" -}}
{{- printf "%s-%s" (include "sigrun.fullname" .) .Values.persistence.name }}
{{- end }}

{{/*
The Deployment's selector component label is FIXED at "server": the
ServiceMonitor selects Services (not pods) by {name, component: server}, so
the ClusterIP Service must keep component: server while the optional
Tailscale LB Service deliberately carries a DIFFERENT component
(tailscale-lb) — a second Service with the {name, component: server} pair
would become a second scrape target to the same pods (double scrapes /
duplicated up{} series).
*/}}
{{- define "sigrun.serverSelectorLabels" -}}
{{- include "sigrun.componentLabels" (dict "Chart" .Chart "Values" .Values "Release" .Release "component" "server") }}
{{- end }}