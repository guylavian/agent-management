# Enterprise integration points

Items are ordered by gate. Mock results do not replace real-environment verification.

## Gate 1 — identity and authorization

- TODO: Verify enterprise OIDC issuer, audience, group/role claim mapping, key rotation, clock skew, and token revocation behavior.
- TODO: Prove the supported user-bound token-exchange pattern across Runtime to ToolHive to MCP; confirm audit records identify two effective human principals rather than a shared runtime identity.
- TODO: Re-run AG-01, AG-02, and AG-03 with ToolHive gateway policy and read-only backend credentials.
- TODO: Confirm ToolHive denies unauthorized tools before an MCP backend call and exports correlated events to Splunk/QRadar.

## Gate 2 — evidence services

- TODO: Validate ACL filtering inside the enterprise RAG service for two users, including deletions and group changes.
- TODO: Validate real AD, OpenShift, Prometheus, Splunk, and network MCP schemas, response bounds, deadlines, retry ownership, and read-only backend roles.
- TODO: Validate the selected enterprise DLP boundary after deterministic local redaction.

## Models and observability

- TODO: Verify pinned vLLM structured-output syntax and tool parser for the mirrored Tier-S model.
- TODO: Select and pin a Tier-L candidate and repeat judge calibration against human review.
- TODO: Select the self-hosted observability backend and verify OTLP attribute acceptance and retention policy.

## Air gap and deployment

- TODO: Mirror and scan every lockfile artifact and the Node base image, then build with network disabled.
- TODO: Pin and mirror ToolHive operator/chart/images, MCP server images, vLLM images/model files, and retrieval model artifacts after enterprise selection.
- TODO: Validate default-deny OpenShift NetworkPolicies and non-root/read-only filesystem settings in the target cluster.
- TODO: Decide the controlled PoC vector store before enabling the real RAG implementation.
- TODO: Run the autocannon normal, burst, and mock-only storm profiles in a CI/dev runner that permits TCP listeners; this sandbox returns `listen EPERM`.
