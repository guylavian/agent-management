{{- define "sre-agent.fullname" -}}
sre-agent-{{ .Values.agent.name }}
{{- end }}

{{- define "sre-agent.selectorLabels" -}}
app.kubernetes.io/name: sre-agent-runtime
app.kubernetes.io/instance: {{ .Release.Name }}
sre.ai/agent: {{ .Values.agent.name }}
sre.ai/mode: {{ .Values.agent.mode }}
{{- end }}

{{- define "sre-agent.labels" -}}
{{ include "sre-agent.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: sre-agent-platform
{{- end }}
