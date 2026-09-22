#!/usr/bin/env bash

set -euo pipefail

suite_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_dir="${1:?Usage: scripts/test.sh /path/to/deepseek-harness}"
source_root="$(cd -- "$source_dir" && pwd -P)"

if [[ "$source_root" == "$suite_root" ]]; then
  printf '%s\n' 'Pass a separate deepseek-harness source checkout.' >&2
  exit 2
fi

git -C "$source_root" rev-parse --show-toplevel >/dev/null

while IFS= read -r relative_path; do
  [[ -n "$relative_path" ]] || continue
  if [[ ! -f "$suite_root/overlay/$relative_path" ]]; then
    printf 'Overlay file is missing: %s\n' "$relative_path" >&2
    exit 2
  fi
done < "$suite_root/overlay-files.txt"

cp -a "$suite_root/overlay/." "$source_root/"

cd "$source_root"
pnpm exec vitest run --config vitest.config.ts \
  packages/test-support/session-snapshot/tests/manifest.spec.ts \
  packages/test-support/session-snapshot/tests/tui.spec.ts \
  packages/test-support/session-snapshot/tests/tui-suite.spec.ts \
  packages/tui/tui-render/tests/hud-layout.spec.ts \
  packages/tui/tui-render/tests/jobs-hud.spec.tsx \
  packages/tui/tui-render/tests/plugins-pane.spec.tsx \
  packages/tui/tui-render/tests/todo-hud.spec.tsx \
  packages/tui/tui-render/tests/visual-conformance.spec.tsx \
  packages/tui/tui-render/tests/workflow-hud.spec.tsx \
  packages/tui/tui/tests/jobs-hud.spec.ts \
  packages/tui/tui/tests/plugins-pane-integration.spec.ts \
  packages/tui/tui/tests/render-policy.spec.ts \
  packages/tui/tui/tests/workflow-hud.spec.ts

pnpm exec vitest run --config vitest.expected.config.ts \
  apps/cli/tests/deepseek-tui-plugins.expected.e2e.ts

pnpm exec vitest run --config vitest.snapshot.config.ts \
  snapshots/tui/tui.snapshot.ts \
  scripts/session-snapshot-corpus.corpus.ts
