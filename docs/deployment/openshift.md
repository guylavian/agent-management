# OpenShift topology — one Deployment per Agent

Argo CD applies the single generic chart (`deploy/runtime/helm`) once per logical
agent, using the values the renderer produced under
`deploy/environments/<env>/rendered/agents/`. Those files are generated and
committed — never hand-written — so this is what the cluster actually gets.
Every release produces a Deployment, Service, ServiceAccount, NetworkPolicy and
optional HPA/PDB named `sre-agent-<agent>`; all releases run the same
`sre-agent-runtime` image and differ only in values.

Normally the ApplicationSet does this — it discovers the rendered files, so
adding an Agent needs no change here. The equivalent by hand:

```sh
R=deploy/environments/production/rendered/agents
helm install sre-agent-manager               deploy/runtime/helm -f $R/manager.yaml               -n sre-assistant
helm install sre-agent-active-directory      deploy/runtime/helm -f $R/active-directory.yaml      -n sre-assistant
helm install sre-agent-openshift             deploy/runtime/helm -f $R/openshift.yaml             -n sre-assistant
helm install sre-agent-network-observability deploy/runtime/helm -f $R/network-observability.yaml -n sre-assistant
```

Resulting in-namespace topology (`sre-assistant`):

```text
sre-agent-manager                (mode: manager,    2 replicas, PDB)
sre-agent-active-directory       (mode: specialist, 2 replicas, HPA)
sre-agent-openshift              (mode: specialist, 2 replicas, HPA)
sre-agent-network-observability  (mode: specialist, 2 replicas, HPA)
```

Service DNS names must match the `endpointTemplate` in `deploy/environments/<env>/environment.yaml`
(`http://sre-agent-<name>.sre-assistant.svc.cluster.local`).

Shared platform services stay in their own namespaces, labelled
`sre.ai/platform-service: "true"` (vLLM Tier-S/Tier-L, RAG, ToolHive, OTel
collector, PostgreSQL, IdP). The API/gateway namespace carries
`sre.ai/api-client: "true"` and is the only ingress permitted to the manager;
specialists accept ingress only from manager pods. The manager egress excludes
ToolHive/RAG — it never aggregates the specialists' data-plane access.

Prerequisite secret per namespace: `sre-agent-integrations` (see
`deploy/runtime/helm/values.yaml` for the required keys per mode).
