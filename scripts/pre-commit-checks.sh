#!/usr/bin/env bash
#
# The fast checks that run before a commit, invoked by .husky/pre-commit.
#
# Scope is deliberately narrow: everything here finishes in about a second,
# because a slow hook trains people to reach for --no-verify, and a hook everyone
# bypasses is worse than no hook. Typecheck, tests, the build and the security
# scans are NOT here — CI is the real gate for those.
#
# What IS here is the class of mistake that is expensive to undo once pushed: a
# credential, a giant binary, or a conflict marker in the history.
#
# ORDERING IS LOAD-BEARING. The secret scan runs BEFORE lint-staged. lint-staged
# rewrites the index as it formats, so a scan placed after it examines a
# different set of bytes than the ones being committed.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

MAX_FILE_KB=1024
GITLEAKS_IMAGE="zricethezav/gitleaks:v8.30.0"
status=0

fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; status=1; }
note() { printf '  • %s\n' "$1"; }

# Added, copied or modified only — a rename or a deletion has nothing to inspect.
staged=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$staged" ] && exit 0

# --- oversized files ------------------------------------------------------
while IFS= read -r file; do
  [ -f "$file" ] || continue
  size_kb=$(( ( $(wc -c < "$file") + 1023 ) / 1024 ))
  if [ "$size_kb" -gt "$MAX_FILE_KB" ]; then
    fail "$file is ${size_kb}KB (limit ${MAX_FILE_KB}KB). Large files are forever in the history."
  fi
done <<< "$staged"

# --- merge conflict markers ----------------------------------------------
# Anchored at the start of a line and requiring exactly seven characters, so
# prose about conflicts and long ASCII rules do not trip it.
if git diff --cached -U0 | grep -qE '^\+(<{7}|={7}|>{7})( |$)'; then
  fail "a merge conflict marker is staged"
fi

# --- unparseable JSON -----------------------------------------------------
# tsconfig.json and .vscode/*.json are JSONC: TypeScript, Prettier and the
# editors all accept comments there, and this repository uses them to explain
# why each compiler setting is what it is. Comments are stripped before parsing
# those, rather than skipping the files — a malformed tsconfig should still fail
# here, and it is the file most likely to be hand-edited.
strip_jsonc="s://[^\"]*$::; s:/\\*.*\\*/::g"
while IFS= read -r file; do
  case "$file" in
    *.json)
      [ -f "$file" ] || continue
      case "$file" in
        tsconfig*.json | .vscode/*.json) payload=$(sed "$strip_jsonc" "$file") ;;
        *) payload=$(cat "$file") ;;
      esac
      printf '%s' "$payload" | node -e "
        let s='';
        process.stdin.on('data', (d) => (s += d));
        process.stdin.on('end', () => { try { JSON.parse(s); } catch (e) { process.exit(1); } });
      " 2>/dev/null || fail "$file is not valid JSON"
      ;;
  esac
done <<< "$staged"

# --- secrets, in the staged diff -----------------------------------------
# The staged diff only. CI scans the full history; this catches the key before
# it becomes history in the first place, which is the only moment the fix is
# cheap. Skipped without Docker rather than failing the commit — CI still runs
# it, and a hook that blocks work on a missing daemon gets uninstalled.
if command -v docker >/dev/null 2>&1; then
  if ! git diff --cached | docker run --rm -i -v "$REPO_ROOT:/repo" "$GITLEAKS_IMAGE" \
      detect --pipe --config=/repo/.gitleaks.toml --no-banner --redact --exit-code 1 >/dev/null 2>&1; then
    fail "gitleaks found a secret in the staged diff. Do not amend it away — if it is real, ROTATE IT."
  fi
else
  note "docker not found, skipping the staged-diff secret scan (CI still scans the full history)"
fi

[ "$status" -ne 0 ] && exit "$status"

# --- formatting, last, because it rewrites the index ----------------------
npx --no-install lint-staged
