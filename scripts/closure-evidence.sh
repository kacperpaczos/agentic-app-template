#!/usr/bin/env bash
# DIAGNOSTIC (closure 2026-09-15) — collects the evidence the closure report cites.
# Runs the checks and stores their raw output; does not change application code.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/docs/evidence/closure-2026-09-15"
mkdir -p "$OUT"
cd "$ROOT"

run() { # run <file> <label> <cmd...>
  local file="$1"; shift
  local label="$1"; shift
  { echo "### $label"; echo "### $(date -Is)"; echo "### \$ $*"; echo; } > "$OUT/$file"
  "$@" >> "$OUT/$file" 2>&1
  local code=$?
  { echo; echo "### kod wyjscia: $code"; } >> "$OUT/$file"
  echo "$label -> kod $code"
  return 0
}

run 01-typecheck.txt "TypeScript" pnpm typecheck
run 02-tests.txt "Testy jednostkowe i integracyjne (vitest)" pnpm test
run 03-boundaries.txt "Granica platforma–domena" pnpm check:boundaries
run 04-build.txt "Build produkcyjny" pnpm build
run 05-matrix.txt "Macierz odbioru" node scripts/closure-matrix.mjs --summary

{
  echo "### Wersje zaleznosci (przypiecia z manifestow obszaru roboczego)"
  echo "### $(date -Is)"
  echo
  node -e '
    const fs = require("fs"), path = require("path");
    /* Versions are read from the workspace manifests, which pin exact versions,
       and confirmed against the pnpm store. Searching node_modules/.pnpm by name
       alone picks up transitive copies and reports the wrong number. */
    const manifests = ["package.json"];
    for (const dir of ["packages", "apps"]) {
      for (const name of fs.readdirSync(dir)) {
        const f = path.join(dir, name, "package.json");
        if (fs.existsSync(f)) manifests.push(f);
      }
    }
    const declared = new Map();
    for (const f of manifests) {
      const m = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const field of ["dependencies", "devDependencies"]) {
        for (const [k, v] of Object.entries(m[field] ?? {})) {
          if (String(v).startsWith("workspace:")) continue;
          declared.set(k, v);
        }
      }
    }
    const store = fs.existsSync("node_modules/.pnpm") ? fs.readdirSync("node_modules/.pnpm") : [];
    const present = (name, version) => {
      const key = name.replace("/", "+") + "@" + version;
      return store.some((d) => d === key || d.startsWith(key + "_"));
    };
    for (const [name, version] of [...declared].sort()) {
      console.log(name.padEnd(36), String(version).padEnd(12), present(name, version) ? "w magazynie" : "nie potwierdzono w magazynie");
    }
    console.log();
    console.log("node".padEnd(36), process.version);
  '
} > "$OUT/06-wersje.txt" 2>&1
echo "wersje -> zapisane"

{
  echo "### Manifest sum kontrolnych zrodel po domknieciu"
  echo "### $(date -Is)"
  echo
  find packages apps e2e tests scripts -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' -o -name '*.css' -o -name '*.json' -o -name '*.sh' \) \
    -not -path '*/node_modules/*' -not -path '*/dist/*' | sort | xargs sha256sum
} > "$OUT/07-manifest-po.txt" 2>&1
echo "manifest -> zapisany"
