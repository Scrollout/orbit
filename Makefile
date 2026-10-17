# CI entry point (ci/README.md): local and GitHub Actions run these targets, every tool inside the toolbox image
# built from ci/Dockerfile, so the host needs only git, make and docker. Everything else of CI lives under ci/.
CI_IMAGE ?= orbit-ci-toolbox:dev
export CI_IMAGE
IN := ci/scripts/in-toolbox.sh

.PHONY: help toolbox vet quality security report report-test plugin-validate ci
.DEFAULT_GOAL := help

## help: list the targets
help:
	@sed -n 's/^## //p' $(MAKEFILE_LIST)

## toolbox: build the CI image (docker layer cache makes a rebuild without changes quick)
toolbox:
	@docker build -q -t $(CI_IMAGE) ci >/dev/null && echo "toolbox: built $(CI_IMAGE)" >&2

## vet: static checks (shellcheck, node --check, JSON, actionlint, hadolint, report self-test, plugin validate and its self-test)
vet: toolbox
	@$(IN) sh ci/scripts/vet.sh

## quality: the plugin's npm test and eslint
quality: toolbox
	@$(IN) sh ci/scripts/quality.sh

## security: gitleaks on the tree and the history, eslint-plugin-security, dependency check
security: toolbox
	@$(IN) sh ci/scripts/security.sh

## report: print the Markdown report of the last run (ci/out) on stdout
report: toolbox
	@$(IN) node ci/scripts/report.mjs

## report-test: self-test of the report renderer against fixtures
report-test: toolbox
	@$(IN) node ci/scripts/report.test.mjs

## plugin-validate: claude plugin validate (marketplace and plugin) from the pinned Claude Code, offline; any warning but CLAUDE.md at the root fails
plugin-validate: toolbox
	@$(IN) sh ci/scripts/plugin-validate.sh

## ci: clears ci/out, then vet, quality, security in that order, all run even after a failure; prints the report; fails if any failed
ci: toolbox
	@rm -rf ci/out && mkdir ci/out; rc=0; for t in vet quality security; do $(MAKE) --no-print-directory $$t || rc=1; done; \
	  $(MAKE) --no-print-directory report || rc=1; \
	  if [ $$rc -eq 0 ]; then echo "ci: PASS"; else echo "ci: FAIL"; fi; exit $$rc
