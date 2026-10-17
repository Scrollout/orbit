# CI entry point (ci/README.md): local and GitHub Actions run these targets, every tool inside the toolbox image
# built from ci/Dockerfile, so the host needs only git, make and docker. Everything else of CI lives under ci/.
CI_IMAGE ?= orbit-ci-toolbox:dev
export CI_IMAGE
IN := ci/scripts/in-toolbox.sh

.PHONY: help toolbox vet quality security sast report report-test plugin-validate ci bump
.DEFAULT_GOAL := help

## help: list the targets
help:
	@sed -n 's/^## //p' $(MAKEFILE_LIST) | awk -F': ' '{ n = $$1; sub(/^[^:]*: /, ""); printf "  %-16s %s\n", n, $$0 }'

## toolbox: build the CI image (SKIP_TOOLBOX_BUILD=1 reuses a loaded one)
toolbox:
	@if [ -n "$$SKIP_TOOLBOX_BUILD" ] && docker image inspect $(CI_IMAGE) >/dev/null 2>&1; then echo "toolbox: reusing $(CI_IMAGE)" >&2; else docker build -q -t $(CI_IMAGE) ci >/dev/null && echo "toolbox: built $(CI_IMAGE)" >&2; fi

## vet: static checks: shell, node, JSON, workflows, plugin validate
vet: toolbox
	@$(IN) sh ci/scripts/vet.sh

## quality: eslint, tsc and the plugin tests
quality: toolbox
	@$(IN) sh ci/scripts/quality.sh

## security: gitleaks, eslint-plugin-security, dependency check
security: toolbox
	@$(IN) sh ci/scripts/security.sh

## sast: Opengrep and Checkov, offline, against ci/sast-baseline.json
sast: toolbox
	@$(IN) sh ci/scripts/sast.sh

## report: print the Markdown report of the last run
report: toolbox
	@$(IN) node ci/scripts/report.mjs

## report-test: self-test of the report renderer
report-test: toolbox
	@$(IN) node ci/scripts/report.test.mjs

## plugin-validate: claude plugin validate, offline; warnings fail
plugin-validate: toolbox
	@$(IN) sh ci/scripts/plugin-validate.sh

## ci: vet, quality, security, sast, then the report; fails if any failed
ci: toolbox
	@rm -rf ci/out && mkdir ci/out; rc=0; for t in vet quality security sast; do $(MAKE) --no-print-directory $$t || rc=1; done; \
	  $(MAKE) --no-print-directory report || rc=1; \
	  if [ $$rc -eq 0 ]; then echo "ci: PASS"; else echo "ci: FAIL"; fi; exit $$rc

## bump: version ritual: make bump V=x.y.z [RULES=x.y.z]
bump:
	@test -n "$(V)" || { echo "usage: make bump V=<x.y.z> [RULES=<x.y.z>]" >&2; exit 2; }
	@printf '%s' "$(V)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$' || { echo "bump: V=$(V) is not X.Y.Z semver" >&2; exit 2; }
	@test -z "$(RULES)" || printf '%s' "$(RULES)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$' || { echo "bump: RULES=$(RULES) is not X.Y.Z semver" >&2; exit 2; }
	@node -e 'const fs=require("fs");const set=(f,v)=>{const j=JSON.parse(fs.readFileSync(f,"utf8"));j.version=v;fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")};set(".claude-plugin/plugin.json",process.argv[1]);if(process.argv[2])set("rules/rules.json",process.argv[2])' "$(V)" "$(RULES)"
	@node scripts/manifest.mjs --update
