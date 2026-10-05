#!/bin/bash
# Scaffold for every case: the sample GTM project, plus each pack's scorers
# under .claude/skills/, copied from the pack repos cloned next to this one
# (the eval's HOME is a sandbox, so installed packs are not visible).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SIBLINGS=$(cd "$HERE/../.." && pwd)
cp -R "$HERE/fixtures/acme/." .
while read -r repo skill; do
  src="$SIBLINGS/$repo"
  [ -d "$src" ] || continue
  dst=".claude/skills/$skill/scripts"
  mkdir -p "$dst"
  if [ -d "$src/scripts" ]; then cp -R "$src/scripts/." "$dst/"; fi
  if [ -d "$src/skills/$skill/scripts" ]; then cp -R "$src/skills/$skill/scripts/." "$dst/"; fi
done <<'PACKS'
claude-psp psp
claude-evp evp
claude-prospect-list who-to-contact
claude-cold-email cold-email
claude-sales-offer cold-offer
claude-pricing pricing
claude-landing-page page
claude-email-sequence lifecycle-email
claude-geo geo
claude-founder-brand founder-brand
PACKS
