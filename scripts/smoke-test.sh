#!/usr/bin/env bash
#
# Smoke test: pack the tarball, install it into a throwaway prefix, and run the
# binary a user would actually get.
#
# The unit and end-to-end suites both run against the working tree. This is the
# only check that exercises the published artifact, and it catches the class of
# failure that is invisible until after `npm publish`:
#
#   1. `files` in package.json omits something the bundle needs at runtime.
#   2. `bin` points at a path that does not exist in the tarball.
#   3. The bundle imports something that was a devDependency.
#   4. The installed binary is not executable, or has no shebang.
#   5. `--version` reports something other than the version being packed —
#      version.ts walks up looking for a package.json, and the layout inside
#      node_modules is not the layout in the repository.
#
# Deliberately offline: it runs --version and --help, and one command with a
# bogus key against a base URL that resolves nowhere, to prove the failure path
# reports rather than hangs. Nothing here needs credentials or a network.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORK="$(mktemp -d)"
FAILURES=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

EXPECTED_VERSION="$(node -p "require('./package.json').version")"
echo "==> packing @senso-ai/cli ${EXPECTED_VERSION}"

npm run build >/dev/null 2>&1 || { fail "build failed"; exit 1; }
TARBALL="$(npm pack --silent --pack-destination "$WORK" 2>/dev/null | tail -1)"
[ -n "$TARBALL" ] && [ -f "$WORK/$TARBALL" ] || { fail "npm pack produced no tarball"; exit 1; }
pass "packed $TARBALL"

# --- what is actually in the tarball -------------------------------------
contents="$(tar tzf "$WORK/$TARBALL")"
for required in "package/dist/cli.js" "package/package.json" "package/README.md" "package/LICENSE"; do
  if grep -qx "$required" <<< "$contents"; then
    pass "tarball contains ${required#package/}"
  else
    fail "tarball is missing ${required#package/}"
  fi
done

# The tarball must not ship source, tests or configuration. They are not secret,
# but they inflate every install and imply a support surface that is not offered.
if grep -qE '^package/(src|tests|scripts|\.github)/' <<< "$contents"; then
  fail "tarball ships source, tests or CI config — check the \`files\` field"
else
  pass "tarball ships only the built bundle and its metadata"
fi

# --- install it the way a user would -------------------------------------
echo "==> installing into a clean prefix"
PREFIX="$WORK/prefix"
mkdir -p "$PREFIX"
if ! npm install --silent --prefix "$PREFIX" "$WORK/$TARBALL" >/dev/null 2>&1; then
  fail "npm install of the tarball failed"
  exit 1
fi

BIN="$PREFIX/node_modules/.bin/senso"
[ -x "$BIN" ] && pass "senso is installed and executable" || { fail "senso is not executable at $BIN"; exit 1; }

head -c 2 "$PREFIX/node_modules/@senso-ai/cli/dist/cli.js" | grep -q '#!' \
  && pass "bundle carries a shebang" || fail "bundle has no shebang"

# --- run it ---------------------------------------------------------------
# HOME and XDG_CONFIG_HOME are redirected so the smoke test can never read or
# write the developer's real credentials.
export HOME="$WORK/home"
export XDG_CONFIG_HOME="$WORK/home/.config"
export SENSO_NO_UPDATE_CHECK=1
mkdir -p "$XDG_CONFIG_HOME"

actual_version="$("$BIN" --version 2>/dev/null)"
if [ "$actual_version" = "$EXPECTED_VERSION" ]; then
  pass "--version reports $actual_version"
else
  fail "--version reported '$actual_version', expected '$EXPECTED_VERSION'"
fi

if "$BIN" --help 2>/dev/null | grep -q "Infrastructure for the Agentic Web"; then
  pass "--help renders"
else
  fail "--help did not render"
fi

# --version must not create a config directory: it is meant to be offline and
# free of side effects, which is what makes it usable as a container healthcheck.
if [ -e "$XDG_CONFIG_HOME/senso" ]; then
  fail "--version created a config directory"
else
  pass "--version left no config directory behind"
fi

# A command with no credential must fail fast, on stderr, with a usable message —
# not hang, and not print a stack trace.
out="$("$BIN" whoami --output json 2>"$WORK/err.txt")"
code=$?
if [ "$code" -eq 3 ]; then
  pass "an unauthenticated command exits 3"
else
  fail "an unauthenticated command exited $code, expected 3"
fi
if [ -z "$out" ]; then
  pass "nothing was written to stdout on failure"
else
  fail "stdout was not empty on failure: $out"
fi
if grep -q "SENSO_API_KEY" "$WORK/err.txt"; then
  pass "the error names the environment variable to set"
else
  fail "the error did not explain how to authenticate: $(cat "$WORK/err.txt")"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "==> smoke: OK"
else
  echo "==> smoke: $FAILURES failure(s)" >&2
fi
exit "$FAILURES"
