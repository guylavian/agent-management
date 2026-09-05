#!/usr/bin/env bash
# Build a distributable source snapshot that cannot carry credentials.
#
# An ad-hoc `zip -x '*/node_modules/*' ...` shipped five real secret files:
# platform/.env.real-poc, two delegation keys, a TLS key and a mock OIDC key.
# Each is correctly gitignored, which is exactly why an exclusion list written
# around "what's big" missed them — .gitignore keeps them out of Git, and
# nothing kept them out of the archive.
#
# The archive is therefore built FROM GIT rather than from the working tree:
# `git archive` emits exactly the tracked files, and validate:tracked already
# refuses to let a credential become tracked. One policy, enforced in one place,
# instead of two lists that have to agree.
#
#   ./tools/make-source-zip.sh [output.zip]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-${HOME}/Desktop/sre-agent-src.zip}"

cd "${root}"

# The same gate CI runs. A credential cannot be tracked, so it cannot be
# archived — but only if this actually passes, so it is not advisory here.
echo "==> verifying no credential is tracked"
( cd platform && npm run --silent validate:tracked )

echo "==> writing ${out}"
rm -f "${out}"
git archive --format=zip -o "${out}" HEAD

# Belt and braces: prove the result is clean rather than trusting the pipeline.
# `.example` files are fixtures and are meant to ship.
echo "==> auditing archive"
if unzip -l "${out}" \
  | grep -iE '\.(pem|key|p12|pfx|jks|mv\.db|trace\.db)$|(^|/)\.env($|\.)|/certs/' \
  | grep -viE '\.example' ; then
  echo "REFUSING: the archive above contains credential-shaped files" >&2
  rm -f "${out}"
  exit 1
fi

printf '%s  (%s, %s files)\n' "${out}" \
  "$(du -h "${out}" | cut -f1)" \
  "$(unzip -l "${out}" | tail -1 | awk '{print $2}')"
echo "contains tracked files only: untracked local state (.real-poc, .sre-local) is absent by construction"
