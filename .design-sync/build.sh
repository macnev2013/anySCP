#!/usr/bin/env bash
# Builds the inputs design-sync consumes (anySCP is an app, not a library):
#  1. compiled Tailwind v4 CSS (.design-sync/tailwind.css: theme + app utilities + safelist) -> dist/ds/anyscp.css
#  2. .d.ts tree for .design-sync/ds-entry.ts                               -> dist/types/
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
pnpm exec vite build --config .design-sync/vite.css.config.ts >/dev/null
mkdir -p dist/ds
css=$(ls dist/ds/vite/assets/*.css | head -1)
# Public-dir font URLs are absolute (/fonts/...); point them at the repo copies.
sed 's#url(/fonts/#url(../../public/fonts/#g; s#url("/fonts/#url("../../public/fonts/#g; s#url('"'"'/fonts/#url('"'"'../../public/fonts/#g' "$css" > dist/ds/anyscp.css
rm -rf dist/ds/vite
pnpm exec tsc -p .design-sync/tsconfig.dts.json
cat > dist/types/index.d.ts <<'DTS'
export * from "./.design-sync/ds-entry";
DTS
