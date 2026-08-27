# OpenShift topology — one Deployment per Agent

GitOps renders the single generic chart (`deploy/helm`) once per logical agent.
Every release produces a Deployment, Service, ServiceAccount, NetworkPolicy and
optional HPA/PDB named `sre-agent-<agent>`; all releases run the same
`sre-agent-runtime` image and differ only in values.

```sh
helm install sre-agent-manager               deploy/helm -f deploy/helm/values/manager.yaml               -n sre-assistant
helm install sre-agent-active-directory      deploy/helm -f deploy/helm/values/active-directory.yaml      -n sre-assistant
helm install sre-agent-openshift             deploy/helm -f deploy/helm/values/openshift.yaml             -n sre-assistant
helm install sre-agent-network-observability deploy/helm -f deploy/helm/values/network-observability.yaml -n sre-assistant
```

Resulting in-namespace topology (`sre-assistant`):

```text
sre-agent-manager                (mode: manager,    2 replicas, PDB)
sre-agent-active-directory       (mode: specialist, 2 replicas, HPA)
sre-agent-openshift              (mode: specialist, 2 replicas, HPA)
sre-agent-network-observability  (mode: specialist, 4 replicas, HPA)
```

Service DNS names must match `agents/registry.yaml` endpoints
(`http://sre-agent-<name>.sre-assistant.svc.cluster.local`).

Shared platform services stay in their own namespaces, labelled
`sre.ai/platform-service: "true"` (vLLM Tier-S/Tier-L, RAG, ToolHive, OTel
collector, PostgreSQL, IdP). The API/gateway namespace carries
`sre.ai/api-client: "true"` and is the only ingress permitted to the manager;
specialists accept ingress only from manager pods. The manager egress excludes
ToolHive/RAG — it never aggregates the specialists' data-plane access.

Prerequisite secret per namespace: `sre-agent-integrations` (see
`deploy/helm/values.yaml` for the required keys per mode).
