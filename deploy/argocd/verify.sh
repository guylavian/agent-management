#!/usr/bin/env bash
# Prove the GitOps path end to end: Git -> Argo CD -> Deployments -> Ready pods,
# all on the one shared runtime image.
#
#   ./deploy/argocd/verify.sh
set -euo pipefail

ns="${SRE_NAMESPACE:-sre-assistant}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail=0
check() { if [ "$1" = 0 ]; then echo "  PASS  $2"; else echo "  FAIL  $2"; fail=1; fi; }

echo "== 1. Argo CD healthy"
for d in argocd-server argocd-repo-server argocd-applicationset-controller; do
  ready="$(kubectl -n argocd get deploy "$d" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
  check "$([ "${ready:-0}" -ge 1 ] && echo 0 || echo 1)" "$d ready"
done

echo "== 2. repository connected"
kubectl -n argocd get secret sre-agent-platform-repo >/dev/null 2>&1
check $? "repository secret present"

echo "== 3. Applications generated from Git"
# The expected set is whatever Git says is enabled — read it from the working
# tree rather than hard-coding names, so this check cannot drift from the repo.
expected="$(ls "${root}/deploy/environments/local/rendered/agents/" | sed 's/\.yaml$//' | sort)"
actual="$(kubectl -n argocd get applications -o jsonpath='{range .items[*]}{.metadata.labels.sre\.ai/agent}{"\n"}{end}' 2>/dev/null | grep -v '^$' | sort)"
echo "  git says:  $(echo "$expected" | tr '\n' ' ')"
echo "  argo has:  $(echo "$actual" | tr '\n' ' ')"
[ "$expected" = "$actual" ]
check $? "Application set matches enabled agents in Git"

echo "== 4. sync + health"
while read -r name sync health; do
  [ -z "$name" ] && continue
  [ "$sync" = Synced ] && [ "$health" = Healthy ]
  check $? "$name ($sync/$health)"
done <<< "$(kubectl -n argocd get applications -o jsonpath='{range .items[*]}{.metadata.name} {.status.sync.status} {.status.health.status}{"\n"}{end}' 2>/dev/null)"

echo "== 5. Deployments and pods"
for agent in $expected; do
  ready="$(kubectl -n "$ns" get deploy "sre-agent-$agent" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
  check "$([ "${ready:-0}" -ge 1 ] && echo 0 || echo 1)" "deployment sre-agent-$agent ready (${ready:-0})"
done

echo "== 6. one shared image"
images="$(kubectl -n "$ns" get deploy -o jsonpath='{range .items[*]}{.spec.template.spec.containers[0].image}{"\n"}{end}' 2>/dev/null | sort -u)"
echo "  distinct images: $(echo "$images" | tr '\n' ' ')"
[ "$(echo "$images" | grep -c .)" = 1 ]
check $? "every agent runs one image"

echo "== 7. workloads owned by Argo, not kubectl"
# Ownership means Argo's tracking annotation names an Application, per Deployment.
# Counting label occurrences across the whole JSON would pass on a namespace
# where one Argo-owned Deployment sits beside three hand-applied ones.
total="$(kubectl -n "$ns" get deploy --no-headers 2>/dev/null | wc -l | tr -d ' ')"
owned=0
for d in $(kubectl -n "$ns" get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
  inst="$(kubectl -n "$ns" get deploy "$d" \
    -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/tracking-id}' 2>/dev/null)"
  [ -n "$inst" ] || inst="$(kubectl -n "$ns" get deploy "$d" \
    -o jsonpath='{.metadata.labels.app\.kubernetes\.io/instance}' 2>/dev/null)"
  if [ -n "$inst" ]; then owned=$((owned + 1)); else echo "    unowned: $d"; fi
done
[ "$total" -gt 0 ] && [ "$owned" = "$total" ]
check $? "$owned/$total deployments owned by an Argo Application"

echo
# multi-source Applications report `revisions` (plural); `revision` is empty
echo "revision deployed: $(kubectl -n argocd get applications \
  -o jsonpath='{.items[0].status.sync.revisions[0]}' 2>/dev/null | cut -c1-8)"
echo "revision in git:   $(git -C "${root}" rev-parse HEAD | cut -c1-8)"
[ "$fail" = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
