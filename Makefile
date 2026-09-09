# The entry point for everything. CI (.github/workflows/testing.yml) invokes
# these exact targets in this exact order, so a green `make all` locally and a
# green pipeline cannot mean different things. If you add a check, add it here
# first and have CI call it — never the other way round.
#
# Two targets are deliberately NOT in `all`:
#   e2e-matrix  runs only in CI, across three operating systems and three Node
#               versions. Locally you have one of each, so `make e2e` covers it.
#   live        spends real credits against a real organization. See its comment.

NPM  := npm
NPX  := npx --no-install

.DEFAULT_GOAL := help
.PHONY: help install lint format typecheck security unit e2e coverage build smoke all clean live reference

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (npm ci — respects the lockfile)
	$(NPM) ci

lint: ## ESLint + Prettier check (no files written)
	$(NPX) eslint .
	$(NPX) prettier --check .

format: ## Rewrite files with Prettier and apply ESLint's safe fixes
	$(NPX) prettier --write .
	$(NPX) eslint . --fix

typecheck: ## tsc --noEmit over src, tests and scripts
	$(NPX) tsc --noEmit

# Three different jobs, deliberately all here.
#
# `npm audit` is SCA — our dependencies against a CVE database. It fails on high
# and critical only: moderate advisories in transitive build-time dependencies
# would otherwise block every pull request on something nobody can act on, and a
# gate that is routinely overridden stops being read at all. As of 2026-09-09 the
# only outstanding advisory is a low-severity esbuild dev-server path this CLI
# never executes.
#
# semgrep is SAST — it analyses OUR code, which npm audit never looks at. This
# CLI reads a credential off disk, puts it in an HTTP header, shells out to npm
# and to shipables, and writes files the user names. Those are the shapes a
# static analyser exists to watch.
#
# gitleaks is secret scanning over the FULL history rather than the working tree:
# a credential that was committed and later deleted is still clonable. It runs
# here, not only in CI, so that "CI runs the same targets you do" stays literally
# true.
#
# All three run from pinned images rather than marketplace actions — one fewer
# third party with write access to the pipeline, and a scan whose ruleset changes
# under you is a scan whose green means nothing.
SEMGREP_IMAGE  := semgrep/semgrep:1.145.0
GITLEAKS_IMAGE := zricethezav/gitleaks:v8.30.0

security: ## Dependency audit (SCA) + static analysis (SAST) + secret scan
	$(NPM) audit --audit-level=high
	@command -v docker >/dev/null || { echo "docker is required for the SAST and secret scans"; exit 1; }
	docker run --rm -v "$(CURDIR):/src" $(SEMGREP_IMAGE) \
		semgrep --config=p/javascript --config=p/security-audit \
		--error --metrics=off \
		--exclude=node_modules --exclude=dist --exclude=coverage /src
	docker run --rm -v "$(CURDIR):/repo" $(GITLEAKS_IMAGE) \
		detect --source=/repo --config=/repo/.gitleaks.toml --no-banner --redact --exit-code 1

# `--project unit` is load-bearing. Without it vitest runs every configured
# project, which pulls in e2e — and e2e drives the BUILT bundle, which this
# target does not build. That failed in CI while passing on every developer
# machine, because a stale dist/ from an earlier build was always lying around
# locally. If you are tempted to drop the flag, that is the bug you are
# recreating.
unit: ## Unit, command and policy tests with the coverage gate. Touches no network.
	$(NPX) vitest run --project unit --coverage

e2e: ## Drive the built CLI as a subprocess against a local mock API
	$(NPM) run build
	$(NPX) vitest run --project e2e

build: ## Bundle the CLI with tsup
	$(NPM) run build

# The artifact users actually install is the npm tarball, not the source tree.
# `npm pack` it, install it into a throwaway prefix, and run the installed
# binary — that is the only check that catches a missing `files` entry, a bad
# `bin` path, or a bundle that references something outside dist/.
smoke: ## Pack the tarball, install it clean, and run the installed binary
	./scripts/smoke-test.sh

reference: ## Regenerate docs/reference/commands.md from the command tree
	$(NPX) tsx scripts/gen-reference.ts

all: lint typecheck security unit e2e build smoke ## The full local pipeline (what CI runs)
	@echo ""
	@echo "==> make all: OK"

clean: ## Remove build output and caches
	rm -rf dist coverage .vitest node_modules/.cache *.tgz

# Hits a real Senso API with a real organization key. Deliberately not part of
# `all` and never a pull request gate: it needs a secret, so it cannot run on a
# fork, and a check that silently skips when the secret is absent reports green
# without having run — which is worse than no check. Read-only commands only.
live: ## Read-only canary against a live Senso API (needs SENSO_API_KEY)
	$(NPX) tsx scripts/live-canary.ts
