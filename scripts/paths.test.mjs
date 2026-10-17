import test from "node:test";
import assert from "node:assert/strict";
import { classify, codeFiles } from "./paths.mjs";

test("classify: tests are recognised by directory and by file name", () => {
  for (const p of ["test/a.go", "src/tests/x.rs", "pkg/__tests__/a.js", "spec/a.rb", "src/a_test.go", "a/b_test.py", "a/b_spec.rb", "web/a.test.ts", "web/a.spec.tsx", "web/a.test.mjs", "web/a.test.js", "x/test_thing.py"]) assert.equal(classify(p), "test", p);
});

test("classify: docs by extension and directory, including LICENSE", () => {
  for (const p of ["README.md", "notes.txt", "a/b.rst", "a/b.adoc", "a.mdx", "docs/guide.html", "doc/x.png", "LICENSE", "LICENSE-MIT", "NOTICE", "AUTHORS.txt"]) assert.equal(classify(p), "docs", p);
});

test("classify: config by extension, dotfile and .github", () => {
  for (const p of ["a.yaml", "ci/a.yml", "package.json", "Cargo.toml", "setup.cfg", "go.sum.lock", ".gitignore", "sub/.eslintrc", ".github/CODEOWNERS", "x.ini"]) assert.equal(classify(p), "config", p);
});

test("classify: everything else is production code", () => {
  for (const p of ["src/a.go", "Makefile", "Dockerfile", "web/app.tsx", "scripts/run.sh", "cmd/main.rs", "testdata_loader.go", "contest/a.go", "latest/a.go"]) assert.equal(classify(p), "code", p);
});

test("classify: the first matching class wins (a test under docs, a json test file)", () => {
  assert.equal(classify("docs/test/a.md"), "test");
  assert.equal(classify("web/a.test.json"), "config", "only script test names are tests");
  assert.equal(classify("test/data.json"), "test");
  assert.equal(classify("docs/x.js"), "docs");
});

test("classify takes any value as a path string", () => {
  assert.equal(classify(undefined), "code");
  assert.equal(classify(12), "code");
});

test("codeFiles keeps production code only and tolerates no list", () => {
  assert.deepEqual(codeFiles(["src/a.go", "src/a_test.go", "README.md", "ci.yml", "Makefile"]), ["src/a.go", "Makefile"]);
  assert.deepEqual(codeFiles(undefined), []);
  assert.deepEqual(codeFiles([]), []);
});
