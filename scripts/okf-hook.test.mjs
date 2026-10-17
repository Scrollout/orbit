import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, "..", "hooks", "okf-hook.mjs");
const init = (root) => spawnSync("node", [join(here, "okf-init.mjs"), "--root", root], { encoding: "utf8" });
const fire = (input, cwd) => spawnSync("node", [hook], { encoding: "utf8", input: typeof input === "string" ? input : JSON.stringify(input), cwd });
const tmp = () => mkdtempSync(join(tmpdir(), "hook-"));
const done = (root) => rmSync(root, { recursive: true, force: true });

test("okf-hook: stays silent (exit 0) for input it cannot use", () => {
  const root = tmp(); init(root);
  assert.equal(fire("not json", root).status, 0, "bad JSON");
  assert.equal(fire({}, root).status, 0, "no tool_input");
  assert.equal(fire({ tool_input: {}, cwd: root }, root).status, 0, "no file_path");
  assert.equal(fire({ tool_input: { file_path: join(root, "src/a.go") }, cwd: root }, root).status, 0, "outside the bundle");
  assert.equal(fire({ tool_input: { file_path: join(root, "docs/okf/x.txt") }, cwd: root }, root).status, 0, "not markdown");
  assert.equal(fire({ tool_input: { file_path: join(root, "docs/other/x.md") }, cwd: root }, root).status, 0, "a sibling of the bundle");
  assert.equal(fire({ tool_input: { file_path: join(root, "docs/okf/../../x.md") }, cwd: root }, root).status, 0, "a path that climbs out");
  done(root);
});

test("okf-hook: no bundle on disk means nothing to validate", () => {
  const root = tmp();
  assert.equal(fire({ tool_input: { file_path: join(root, "docs/okf/a.md") }, cwd: root }, root).status, 0);
  done(root);
});

test("okf-hook: a valid bundle passes (exit 0); a broken doc inside it exits 2 with the validator's message", () => {
  const root = tmp(); init(root);
  const f = join(root, "docs/okf/roadmap/m1.md");
  assert.equal(fire({ tool_input: { file_path: f }, cwd: root }, root).status, 0);
  writeFileSync(join(root, "docs/okf/orphan.md"), "---\ntype: Reference\ntitle: O\ndescription: Not indexed.\n---\n**TL;DR:** Orphan.\n");
  const r = fire({ tool_input: { file_path: join(root, "docs/okf/orphan.md") }, cwd: root }, root);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^OKF docs check failed after editing .*orphan\.md/);
  assert.match(r.stderr, /not listed in docs\/okf\/index\.md/);
  assert.equal(r.stdout, "");
  done(root);
});

test("okf-hook: the bundle location comes from .agents/okf.json; a relative file_path resolves from cwd", () => {
  const root = tmp(); init(root);
  mkdirSync(join(root, "kb"));
  writeFileSync(join(root, ".agents/okf.json"), JSON.stringify({ bundle: "kb" }));
  writeFileSync(join(root, "kb/a.md"), "no frontmatter\n");
  const r = fire({ tool_input: { file_path: "kb/a.md" }, cwd: root }, tmpdir());
  assert.equal(r.status, 2, r.stderr);
  assert.equal(fire({ tool_input: { file_path: "docs/okf/roadmap/m1.md" }, cwd: root }, tmpdir()).status, 0, "the default bundle path is no longer the bundle");
  done(root);
});
