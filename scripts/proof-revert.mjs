// Prints the commands that revert only the production part of a diff in a scratch worktree, for the reviewers' proof check
// (DEC-22). Read-only: it runs `git merge-base` and `git diff`, never changes anything. Zero dependencies.
//   node <plugin>/scripts/proof-revert.mjs --base <ref> --head <sha> --worktree <scratch dir> [--keep <test path>]... [--repo .]
// The diff is three-dot: from the merge-base of base and head to head (`git diff --name-status -M <merge-base> <head>`).
// Every changed path not given with --keep (the test files, kept as at head) is reverted to the merge-base:
//   M, T, D  -> git -C <wt> checkout <merge-base> -- <path>      (modified, type-changed or deleted: restored)
//   A, C     -> git -C <wt> rm -q -- <path>                       (added or copied by the diff: removed)
//   R old new -> rm the new path and restore the old one; a rename whose new path is kept is left as at head.
// Output: one `# merge-base <sha>` line, then one shell command per line (paths single-quoted). Exit 2 for a changed path with a
// newline (refused: revert it by hand), 64 bad usage, 70 git failure.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export function revertCommands({ repo = ".", base, head, worktree, keep = [] }) {
  const git = (...a) => {
    const r = spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    if (r.status !== 0) throw Object.assign(new Error(`git ${a.join(" ")}: ${r.stderr.trim()}`), { code: 70 });
    return r.stdout;
  };
  const mb = git("merge-base", base, head).trim();
  const f = git("diff", "--name-status", "-M", "-z", mb, head).split("\0");
  const odd = f.find((p) => p.includes("\n"));
  if (odd !== undefined) throw Object.assign(new Error(`path with a newline: ${JSON.stringify(odd)}; revert it by hand`), { code: 2 });
  const kept = new Set(keep), out = [`# merge-base ${mb}`];
  const restore = (p) => out.push(`git -C ${q(worktree)} checkout ${mb} -- ${q(p)}`);
  const remove = (p) => out.push(`git -C ${q(worktree)} rm -q -- ${q(p)}`);
  for (let i = 0; i < f.length && f[i]; ) {
    const st = f[i][0];
    if (st === "R" || st === "C") {
      const [from, to] = [f[i + 1], f[i + 2]];
      i += 3;
      if (kept.has(to)) continue;
      remove(to);
      if (st === "R") restore(from);
    } else {
      const p = f[i + 1];
      i += 2;
      if (kept.has(p)) continue;
      if (st === "A") remove(p); else restore(p);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const keep = args.flatMap((a, i) => (a === "--keep" && i + 1 < args.length ? [args[i + 1]] : []));
  const base = flag("base"), head = flag("head"), worktree = flag("worktree");
  if (![base, head, worktree].every((x) => x && !x.startsWith("-"))) { console.error("usage: proof-revert.mjs --base <ref> --head <sha> --worktree <dir> [--keep <path>]... [--repo .]"); process.exit(64); }
  try { for (const l of revertCommands({ repo: flag("repo") ?? ".", base, head, worktree, keep })) console.log(l); }
  catch (e) { console.error(`proof-revert: ${e.message}`); process.exit(e.code ?? 70); }
}
