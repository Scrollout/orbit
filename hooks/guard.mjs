// PreToolUse guard: OPR-01 for the operator session, DEC-08 for every session. Zero dependencies.
// Reads the hook event on stdin. Prints a PreToolUse "deny" decision naming the rule, or nothing (allow).
// The operator is the main thread (no `agent_id`) of a session started with `claude --agent orbit:operator`
// (`agent_type`), or of any session with ORBIT_ROLE=operator in its environment. A subagent (`agent_id` set) never is.
// OPR-01 (operator only): no Edit/Write/MultiEdit/NotebookEdit inside the repo's worktrees except .agents/operator.md;
// Bash runs only read-only git (the one exception: a lone `git [-C <dir>] push origin HEAD:<base>` when the profile
// names a base_pusher), no gh merge or ref writes, no shell write into a worktree (redirects and common writers), no
// inline scripts or shells it cannot read. What it cannot parse or resolve is denied (fail closed).
// DEC-08 (any session, only with a profile whose review_trailer is set): a `git merge --no-ff` of a non-base ref, and
// the commit that concludes it, need a readable message with the review trailer in the last paragraph, with Co-Authored-By.
// A guardrail against slips, not a sandbox: it does not model every way a program can write a file.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseProfileText } from "../scripts/profile.mjs";

export const OPERATOR_AGENTS = ["orbit:operator", "operator"];
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const DELEGATE = "every repo change goes to a worker: brief a fresh worker (orbit:coder) on its own branch, or send the owning worker its GO";

export const isOperator = (input, env) => !input?.agent_id && (OPERATOR_AGENTS.includes(input?.agent_type) || env.ORBIT_ROLE === "operator");

// ---------- shell parser (a POSIX subset: quotes, escapes, $(), ``, <(), >(), $VAR, heredocs, ; && || | &) ----------
export class ParseError extends Error {}
const META = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);
const REDIR = /^(\d*)(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)/;
const WRITE_OPS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);

export function parseShell(src, env = {}) {
  // complex: an ||, a pipe, a background & or a condition, loop, case or function: a cd's effect is then unknown.
  const p = { s: src, i: 0, cmds: [], env, f: { complex: false } };
  list(p, 0, null);
  p.cmds.complex = p.f.complex;
  return p.cmds;
}

// close: null (top level), ")" (subshell or substitution), "case" (a case branch: ends at ;; ;& ;;& or esac).
function list(p, depth, close) {
  const s = p.s;
  let cmd = { words: [], redirs: [], heredoc: null, depth }, pending = [];
  const finish = () => { if (cmd.words.length || cmd.redirs.length) p.cmds.push(cmd); cmd = { words: [], redirs: [], heredoc: null, depth }; };
  while (p.i < s.length) {
    const c = s[p.i];
    if (c === " " || c === "\t") { p.i++; continue; }
    if (c === "\\" && s[p.i + 1] === "\n") { p.i += 2; continue; }
    if (c === "\n") { finish(); p.i++; heredocs(p, pending); pending = []; continue; }
    if (c === "#") { while (p.i < s.length && s[p.i] !== "\n") p.i++; continue; }
    if (c === ")") {
      if (close !== ")") throw new ParseError("unmatched )");
      if (pending.length) throw new ParseError("heredoc not terminated");
      finish(); p.i++; return;
    }
    if (close === "case" && c === ";" && (s[p.i + 1] === ";" || s[p.i + 1] === "&")) {
      if (pending.length) throw new ParseError("heredoc not terminated");
      finish(); p.i += s.startsWith(";;&", p.i) ? 3 : 2; return;
    }
    if (c === "(") {
      // `name()`: a function definition; its body is checked like any other commands.
      if (cmd.words.length === 1 && !cmd.redirs.length && /^\(\s*\)/.test(s.slice(p.i))) { p.f.complex = true; p.i = s.indexOf(")", p.i) + 1; cmd.words = []; continue; }
      if (cmd.words.length) throw new ParseError("( inside a command");
      finish(); p.i++; list(p, depth + 1, ")"); continue;
    }
    if (!cmd.words.length && !cmd.redirs.length) {
      const kw = /^(case|esac)(?=[\s;&|()<>]|$)/.exec(s.slice(p.i))?.[1];
      if (kw === "esac" && close === "case") { if (pending.length) throw new ParseError("heredoc not terminated"); finish(); return; }
      if (kw === "case") { p.f.complex = true; p.i += 4; caseBody(p, depth); continue; }
      if (/^(if|elif|while|until|select|function)(?=[\s;&|()<>]|$)/.test(s.slice(p.i))) p.f.complex = true;
    }
    if ((c === ";" || c === "|" || c === "&") && !(c === "&" && s[p.i + 1] === ">")) {
      if (!(c === "&" && s[p.i + 1] === "&") && c !== ";") p.f.complex = true;
      finish(); p.i += s[p.i + 1] === c || (c === "|" && s[p.i + 1] === "&") ? 2 : 1; continue;
    }
    const m = REDIR.exec(s.slice(p.i));
    if (m && !/^[<>]\(/.test(s.slice(p.i + m[1].length))) {
      p.i += m[0].length;
      while (s[p.i] === " " || s[p.i] === "\t") p.i++;
      const w = word(p, depth);
      if (!w) throw new ParseError(`${m[2]} without a target`);
      const op = m[2];
      if (op === "<<" || op === "<<-") {
        if (w.lit === null) throw new ParseError("dynamic heredoc delimiter");
        pending.push({ cmd, delim: w.lit, strip: op === "<<-" });
      } else if (WRITE_OPS.has(op) && !(op === ">&" && /^(\d+|-)$/.test(w.lit ?? ""))) cmd.redirs.push({ op, target: w });
      continue;
    }
    cmd.words.push(word(p, depth));
  }
  if (close) throw new ParseError(close === "case" ? "case without esac" : "unclosed (");
  if (pending.length) throw new ParseError("heredoc not terminated");
  finish();
}

function caseBody(p, depth) {
  const s = p.s, blank = () => { while (/[ \t\n]/.test(s[p.i] ?? "")) p.i++; };
  blank();
  if (!word(p, depth)) throw new ParseError("case without a word");
  blank();
  if (!/^in(?=[\s;]|$)/.test(s.slice(p.i))) throw new ParseError("case without in");
  p.i += 2;
  for (;;) {
    blank();
    if (p.i >= s.length) throw new ParseError("case without esac");
    if (/^esac(?=[\s;&|)]|$)/.test(s.slice(p.i))) { p.i += 4; return; }
    if (s[p.i] === "(") p.i++;
    for (;;) {
      blank();
      if (!word(p, depth)) throw new ParseError("bad case pattern");
      blank();
      if (s[p.i] === "|") { p.i++; continue; }
      if (s[p.i] === ")") { p.i++; break; }
      throw new ParseError("bad case pattern");
    }
    list(p, depth + 1, "case");
  }
}

function heredocs(p, pending) {
  for (const h of pending) {
    const body = [];
    for (;;) {
      if (p.i >= p.s.length) throw new ParseError(`heredoc ${h.delim} not terminated`);
      const nl = p.s.indexOf("\n", p.i), end = nl < 0 ? p.s.length : nl;
      const line = p.s.slice(p.i, end);
      p.i = nl < 0 ? p.s.length : nl + 1;
      if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
      body.push(line);
    }
    h.cmd.heredoc = body.length ? body.join("\n") + "\n" : "";
  }
}

// A word: `lit` is its text when fully static (else null), `exp` its text with $VAR, ${VAR} and ~ expanded from the
// environment (null when anything else is dynamic), `subs` the [from, to) ranges of the commands it substitutes.
function word(p, depth) {
  const s = p.s, start = p.i, subs = [], names = [];
  let lit = "", exp = "", dyn = false, unexp = false, litChars = 0, vars = 0;
  const add = (t) => { lit += t; exp += t; litChars += t.length; };
  const sub = () => { const from = p.cmds.length; list(p, depth + 1, ")"); subs.push([from, p.cmds.length]); dyn = unexp = true; };
  const dollar = () => {
    if (s.startsWith("$((", p.i)) {
      let n = 0;
      for (; p.i < s.length; p.i++) { if (s[p.i] === "(") n++; else if (s[p.i] === ")" && --n === 0) break; }
      if (p.i >= s.length) throw new ParseError("unclosed $((");
      p.i++; dyn = unexp = true; return;
    }
    if (s[p.i + 1] === "(") { p.i += 2; sub(); return; }
    let name = null;
    if (s[p.i + 1] === "{") {
      const e = s.indexOf("}", p.i);
      if (e < 0) throw new ParseError("unclosed ${");
      const inner = s.slice(p.i + 2, e);
      p.i = e + 1;
      if (/^[A-Za-z_]\w*$/.test(inner)) name = inner; else { dyn = unexp = true; return; }
    } else {
      const m = /^[A-Za-z_]\w*/.exec(s.slice(p.i + 1));
      if (m) { name = m[0]; p.i += 1 + name.length; }
      else if (/^[0-9@*#?$!-]/.test(s[p.i + 1] ?? "")) { p.i += 2; dyn = unexp = true; return; }
      else { p.i++; add("$"); return; }
    }
    dyn = true; vars++; names.push(name);
    const v = p.env[name];
    if (v === undefined) unexp = true; else exp += v;
  };
  const backtick = () => {
    let j = p.i + 1, inner = "";
    for (; j < s.length && s[j] !== "`"; j++) { if (s[j] === "\\" && j + 1 < s.length) { j++; inner += s[j]; } else inner += s[j]; }
    if (j >= s.length) throw new ParseError("unclosed `");
    const q = { s: inner, i: 0, cmds: p.cmds, env: p.env, f: p.f }, from = p.cmds.length;
    list(q, depth + 1, null);
    subs.push([from, p.cmds.length]); dyn = unexp = true; p.i = j + 1;
  };
  while (p.i < s.length) {
    const c = s[p.i];
    if ((c === "<" || c === ">") && s[p.i + 1] === "(") { p.i += 2; sub(); continue; }
    if (META.has(c)) break;
    if (c === "\\") { if (s[p.i + 1] !== "\n") add(s[p.i + 1] ?? ""); p.i += 2; continue; }
    if (c === "'") {
      const e = s.indexOf("'", p.i + 1);
      if (e < 0) throw new ParseError("unclosed '");
      add(s.slice(p.i + 1, e)); p.i = e + 1; continue;
    }
    if (c === "$" && s[p.i + 1] === "'") {
      let j = p.i + 2, t = "";
      const esc = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', e: "\x1b", a: "\x07", "0": "\0" };
      for (; j < s.length && s[j] !== "'"; j++) { if (s[j] === "\\" && j + 1 < s.length) { j++; t += esc[s[j]] ?? "\\" + s[j]; } else t += s[j]; }
      if (j >= s.length) throw new ParseError("unclosed $'");
      add(t); p.i = j + 1; continue;
    }
    if (c === '"') {
      p.i++;
      while (p.i < s.length && s[p.i] !== '"') {
        const d = s[p.i];
        if (d === "\\" && "$`\"\\\n".includes(s[p.i + 1] ?? "x")) { if (s[p.i + 1] !== "\n") add(s[p.i + 1]); p.i += 2; }
        else if (d === "$") dollar();
        else if (d === "`") backtick();
        else { add(d); p.i++; }
      }
      if (p.i >= s.length) throw new ParseError('unclosed "');
      p.i++; continue;
    }
    if (c === "$") { dollar(); continue; }
    if (c === "`") { backtick(); continue; }
    if (c === "~" && p.i === start && (p.i + 1 >= s.length || s[p.i + 1] === "/" || META.has(s[p.i + 1]))) {
      lit += "~"; litChars++; p.i++;
      if (p.env.HOME === undefined) unexp = true; else exp += p.env.HOME;
      continue;
    }
    add(c); p.i++;
  }
  if (p.i === start) return null;
  return { lit: dyn ? null : lit, exp: unexp ? null : exp, raw: s.slice(start, p.i), subs, vars: names, onlySub: subs.length === 1 && litChars === 0 && vars === 0 ? subs[0] : null };
}

// ---------- command resolution ----------
const KEYWORDS = new Set(["!", "{", "}", "then", "do", "else", "elif", "if", "while", "until", "fi", "done", "esac"]);
// A variable assignment word: NAME=, NAME+=, NAME[sub]=, NAME[sub]+= (two plain patterns: no nested quantifier, linear time).
export const isAssign = (t) => /^[A-Za-z_]\w*\+?=/.test(t) || /^[A-Za-z_]\w*\[[^\]]*\]\+?=/.test(t);
// `.` does not match a line terminator: a value holding one does not match the `=...` forms below.
const noLineEnd = (t) => !/[\n\r\u2028\u2029]/.test(t);
// Wrapper programs and their options that take a value; the wrapped command follows.
const WRAPPERS = {
  env: ["-u", "--unset", "-C", "--chdir"], command: [], builtin: [], nice: ["-n", "--adjustment"], nohup: [], exec: ["-a"],
  time: [], sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"], timeout: ["-s", "--signal", "-k", "--kill-after"],
  xargs: ["-I", "-n", "-P", "-d", "-L", "-s", "-a", "-E", "-e", "--max-args", "--max-procs", "--delimiter", "--arg-file"], stdbuf: ["-i", "-o", "-e"],
  setsid: [], chronic: [], ionice: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"],
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// Programs that run a command or script the guard cannot see; for the operator they fail closed.
const OPAQUE = new Set(["watch", "script", "flock", "source", "."]);
const SCRIPTERS = { python: /^-[a-zA-Z]*c$/, python3: /^-[a-zA-Z]*c$/, node: { test: (a) => ["-e", "-p", "--eval", "--print"].includes(a) || ((a.startsWith("--eval=") || a.startsWith("--print=")) && noLineEnd(a)) }, perl: /^-[a-zA-Z]*[eEi]/, ruby: /^-[a-zA-Z]*[ei]/ };

export function resolveCmd(words) {
  let i = 0, xargs = false;
  for (;;) {
    while (i < words.length && (KEYWORDS.has(words[i].lit) || isAssign(words[i].raw))) i++;
    const w = words[i];
    if (!w) return null;
    if (w.lit === null) return { dynamic: true };
    if (w.lit === "function") { i += 2; continue; }
    const name = basename(w.lit);
    if (name in WRAPPERS) {
      i++; xargs ||= name === "xargs";
      while (i < words.length) {
        const a = words[i].lit;
        if (a === null) return { dynamic: true };
        if (a === "--") { i++; break; }
        if (name === "env" && isAssign(a)) { i++; continue; }
        if (name === "env" && (/^-[a-zA-Z]*S/.test(a) ? noLineEnd(a) : a === "--split-string" || (a.startsWith("--split-string=") && noLineEnd(a)))) return { name, args: [], opaque: true };
        if (!a.startsWith("-") || a === "-") break;
        i += WRAPPERS[name].includes(a) ? 2 : 1;
      }
      if (name === "timeout") i++;
      continue;
    }
    const args = words.slice(i + 1);
    if (OPAQUE.has(name)) return { name, args, opaque: true };
    if (SHELLS.has(name)) {
      const c = args.findIndex((a) => a.lit !== null && /^-[a-z]*c[a-z]*$/.test(a.lit));
      if (c >= 0) { const j = args[c + 1]?.lit === "--" ? c + 2 : c + 1; return { name, args, inner: args[j]?.lit ?? null }; }
      if (args.length && args.every((a) => a.lit === "--version" || a.lit === "--help")) return { name, args, xargs };
      return { name, args, opaque: true };
    }
    if (name === "eval") return { name, args, inner: args.some((a) => a.lit === null) ? null : args.map((a) => a.lit).join(" ") };
    if (SCRIPTERS[name] && args.some((a) => a.lit === null || SCRIPTERS[name].test(a.lit))) return { name, args, scripter: true };
    return { name, args, xargs };
  }
}

// ---------- context (git and the profile); tests pass their own ----------
const git = (dir, ...a) => {
  const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
};
const todo = (v) => typeof v !== "string" || !v.trim() || /^TODO\b/i.test(v.trim());

// The path with symlinks resolved, for the part of it that exists.
export function real(f) {
  const rest = [];
  for (let cur = f; ; cur = dirname(cur)) {
    try { return join(realpathSync(cur), ...rest); } catch {
      if (dirname(cur) === cur) return f;
      rest.unshift(basename(cur));
    }
  }
}

export function realCtx(cwd, env) {
  const project = env.CLAUDE_PROJECT_DIR ? real(resolve(env.CLAUDE_PROJECT_DIR)) : null;
  const list = (git(cwd, "worktree", "list", "--porcelain") ?? "").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => real(resolve(l.slice(9))));
  const roots = [...new Set([...list, ...(project ? [project] : [])])];
  if (!roots.length) roots.push(real(resolve(cwd)));
  const main = list[0] ?? project ?? real(resolve(cwd));
  const profiles = new Map();
  return {
    roots,
    operatorFiles: [...new Set([main, ...(project ? [project] : [])].map((r) => join(r, ".agents/operator.md")))],
    profile(dir) {
      const key = dir ?? "";
      if (!profiles.has(key)) {
        let data = null;
        for (const r of [dir && git(dir, "rev-parse", "--show-toplevel"), main, project].filter(Boolean)) {
          const f = join(r, ".agents/project.md");
          if (existsSync(f)) { data = parseProfileText(readFileSync(f, "utf8")); if (data) break; }
        }
        profiles.set(key, data && {
          base: todo(data.base_branch) ? null : data.base_branch,
          pusher: ["agent", "owner"].includes(data.base_pusher) ? data.base_pusher : null,
          trailer: todo(data.review_trailer) || data.review_trailer === "none" ? null : data.review_trailer,
        });
      }
      return profiles.get(key);
    },
    mergeHead(dir) {
      const f = git(dir, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD");
      return f && existsSync(f) ? readFileSync(f, "utf8").split("\n")[0].trim() : null;
    },
    baseShas: (dir, base) => [base, `origin/${base}`].map((r) => git(dir, "rev-parse", "--verify", "-q", `${r}^{commit}`)).filter(Boolean),
    readFile: (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } },
  };
}

// ---------- git ----------
const inside = (root, f) => f === root || f.startsWith(root.endsWith(sep) ? root : root + sep);
const shown = (w) => w.raw;

// Global options before the subcommand. A dynamic -C leaves the directory unknown (null): the operator is denied,
// a worker's DEC-08 check still runs, with the session's cwd for the repo state.
function gitSplit(args, cwd, op) {
  let i = 0, dir = cwd, config = false;
  while (i < args.length) {
    const a = args[i].lit;
    if (a === null) return { bad: "a dynamic git option" };
    if (a === "-C") {
      const d = args[i + 1]?.exp;
      if (d == null) { if (op || !args[i + 1]) return { bad: "a dynamic git -C path" }; dir = null; i += 2; continue; }
      dir = isAbsolute(d) ? d : dir && resolve(dir, d); i += 2; continue;
    }
    if (a === "-c" || a === "--config-env") { config = true; i += 2; continue; }
    if (/^(-c.|--config-env=)/.test(a)) { config = true; i++; continue; }
    if (["--git-dir", "--work-tree", "--namespace"].includes(a)) { i += 2; continue; }
    if (/^--(git-dir|work-tree|namespace)=/.test(a) || ["--no-pager", "-p", "--paginate", "-P", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--bare"].includes(a)) { i++; continue; }
    if (["--version", "--help", "--exec-path", "--html-path", "--man-path", "--info-path"].includes(a)) return { dir, config, sub: "version", rest: [] };
    if (a.startsWith("-")) return { bad: `git option ${a}` };
    return { dir, config, sub: a, rest: args.slice(i + 1) };
  }
  return { dir, config, sub: null, rest: [] };
}

// Read-only git: a per-subcommand allowlist of options (default deny; no abbreviations). A spec has
// `bool` long options, `eq` long options that take `=value`, `req` long options whose value may also be the next
// argument, `s` short flags, `sv` short options with a value (attached or next), `so` short options whose value can
// only be attached (the rest of the cluster), and `num` for `-<n>`.
const sp = (o) => ({ bool: new Set((o.bool ?? "").split(" ").filter(Boolean)), eq: new Set((o.eq ?? "").split(" ").filter(Boolean)), req: new Set((o.req ?? "").split(" ").filter(Boolean)), s: o.s ?? "", sv: o.sv ?? "", so: o.so ?? "", num: !!o.num });
const merge = (a, b) => ({ bool: `${a.bool ?? ""} ${b.bool ?? ""}`, eq: `${a.eq ?? ""} ${b.eq ?? ""}`, req: `${a.req ?? ""} ${b.req ?? ""}`, s: (a.s ?? "") + (b.s ?? ""), sv: (a.sv ?? "") + (b.sv ?? ""), so: (a.so ?? "") + (b.so ?? ""), num: a.num || b.num });
const LOG = {
  bool: "oneline stat shortstat numstat name-only name-status graph all decorate no-decorate reverse first-parent merges no-merges patch no-patch raw abbrev-commit no-abbrev-commit full-diff follow cc summary color no-color word-diff color-words cached staged ignore-all-space ignore-space-change ignore-space-at-eol ignore-blank-lines ignore-cr-at-eol minimal patience histogram check exit-code quiet full-index binary no-renames find-renames find-copies find-copies-harder no-ext-diff no-textconv relative no-relative topo-order date-order author-date-order left-right left-only right-only cherry-pick cherry-mark cherry boundary ancestry-path simplify-by-decoration simplify-merges dense sparse full-history show-signature notes no-notes source mailmap use-mailmap no-mailmap remotes branches tags show-pulls dirstat compact-summary show-linear-break children parents ignore-missing all-match invert-grep regexp-ignore-case basic-regexp extended-regexp fixed-strings perl-regexp no-walk do-walk count objects objects-edge single-worktree reflog walk-reflogs irreversible-delete function-context text merge-base no-index no-prefix default-prefix color-moved no-color-moved pickaxe-all pickaxe-regex abbrev no-abbrev root no-commit-id always expand-tabs no-expand-tabs indent-heuristic no-indent-heuristic dual-color no-dual-color submodule ignore-submodules standard-notes no-standard-notes remerge-diff combined-all-paths",
  eq: "format pretty since after until before author committer grep max-count skip date abbrev decorate color word-diff stat dirstat find-renames find-copies diff-filter diff-algorithm unified relative encoding notes show-notes max-parents min-parents exclude glob branches tags remotes submodule ignore-submodules inter-hunk-context anchored color-moved color-moved-ws line-prefix src-prefix dst-prefix output-indicator-new output-indicator-old output-indicator-context break-rewrites rotate-to skip-to diff-merges decorate-refs decorate-refs-exclude creation-factor stat-width stat-name-width stat-graph-width stat-count word-diff-regex expand-tabs ws-error-highlight",
  // req: only options git really takes a separate value for (checked against git 2.53); --format, --pretty are `=` only.
  req: "since after until before author committer grep max-count skip date encoding",
  s: "pusbzwRaiEFPqtWDmcr", sv: "nLSGl", so: "MCBU", num: true,
};
const GIT_SPECS = {
  log: LOG, show: LOG, whatchanged: LOG, "rev-list": LOG, diff: LOG, "diff-tree": LOG, "diff-files": LOG, "diff-index": LOG, cherry: { s: "v", eq: "abbrev" },
  "range-diff": merge(LOG, { bool: "no-dual-color left-only right-only", eq: "creation-factor" }),
  shortlog: { bool: `${LOG.bool} committer numbered summary email`, eq: `${LOG.eq} group`, req: LOG.req.replace(" committer", ""), s: "nsec", so: "w", num: true },
  status: { bool: "short branch long porcelain verbose ahead-behind no-ahead-behind renames no-renames show-stash column no-column null", eq: "porcelain untracked-files ignored ignore-submodules column find-renames", s: "sbvz", so: "u" },
  fetch: { bool: "all prune prune-tags tags no-tags dry-run quiet verbose unshallow force progress no-progress no-recurse-submodules recurse-submodules multiple atomic append refetch write-fetch-head no-write-fetch-head update-shallow no-auto-gc auto-gc ipv4 ipv6 show-forced-updates no-show-forced-updates", eq: "depth deepen shallow-since shallow-exclude recurse-submodules jobs filter", req: "depth deepen shallow-since shallow-exclude jobs filter", s: "pPtnqvfa46", sv: "j" },
  "ls-remote": { bool: "heads tags branches refs quiet exit-code symref get-url", eq: "sort", req: "sort", s: "htbq" },
  "rev-parse": { bool: "verify quiet short abbrev-ref symbolic symbolic-full-name show-toplevel git-dir git-common-dir absolute-git-dir is-inside-work-tree is-inside-git-dir is-bare-repository is-shallow-repository show-prefix show-cdup show-superproject-working-tree all branches tags remotes revs-only no-revs flags no-flags sq not local-env-vars show-object-format show-ref-format keep-dashdash stop-at-non-option", eq: "short abbrev-ref path-format branches tags remotes glob exclude since after until before show-object-format disambiguate", req: "git-path default prefix resolve-git-dir", s: "q" },
  "merge-base": { bool: "all octopus independent is-ancestor fork-point", s: "a" },
  describe: { bool: "tags all long always contains exact-match first-parent dirty broken debug", eq: "abbrev match exclude dirty broken candidates", req: "match exclude candidates" },
  blame: { bool: "porcelain line-porcelain incremental root show-stats show-name show-number reverse first-parent color-lines color-by-age progress no-progress score-debug minimal", eq: "date since abbrev ignore-rev ignore-revs-file encoding", req: "ignore-rev ignore-revs-file date", s: "ltsewpcnfb", sv: "L", so: "MC" },
  "cat-file": { bool: "batch batch-check batch-all-objects buffer unordered follow-symlinks allow-unknown-type batch-command", eq: "batch batch-check batch-command", s: "tsepZ" },
  "ls-files": { bool: "cached deleted modified others ignored stage unmerged killed directory no-empty-directory eol exclude-standard full-name recurse-submodules error-unmatch deduplicate sparse debug resolve-undo abbrev", eq: "exclude exclude-from exclude-per-directory with-tree format abbrev", req: "exclude exclude-from exclude-per-directory with-tree format", s: "cdmoisuktvfz", sv: "xX" },
  "ls-tree": { bool: "long name-only name-status object-only full-name full-tree abbrev", eq: "abbrev format", req: "format", s: "drtlz" },
  grep: { bool: "cached untracked no-index exclude-standard no-exclude-standard recurse-submodules text ignore-case no-ignore-case word-regexp invert-match full-name extended-regexp basic-regexp fixed-strings perl-regexp line-number no-line-number column name-only files-with-matches files-without-match null count color no-color break heading show-function function-context only-matching quiet all-match and or not", eq: "max-depth threads color context after-context before-context max-count", req: "max-depth threads context after-context before-context max-count", s: "aiIwvhHEGFPnlLczqopW", sv: "eABCm" },
  "show-ref": { bool: "head heads branches tags dereference verify quiet exists exclude-existing hash abbrev", eq: "hash abbrev exclude-existing", s: "dsq" },
  "for-each-ref": { bool: "merged no-merged contains no-contains shell perl python tcl color ignore-case omit-empty stdin include-root-refs", eq: "format sort count points-at merged no-merged contains no-contains color exclude", req: "format sort count points-at exclude" },
  "name-rev": { bool: "tags all annotate-stdin name-only no-undefined always stdin", eq: "refs exclude", req: "refs exclude" },
  "check-ignore": { bool: "quiet verbose non-matching no-index stdin", s: "qvnz" },
  "show-branch": { bool: "all remotes topo-order date-order current sparse list merge-base independent no-name sha1-name topics color no-color reflog", eq: "more color reflog", s: "ar" },
  "count-objects": { bool: "verbose human-readable", s: "vH" }, var: { s: "l" }, help: { bool: "all guides", s: "ag" }, version: { bool: "build-options" },
  "symbolic-ref": { bool: "short quiet", s: "q" },
};
for (const k of Object.keys(GIT_SPECS)) GIT_SPECS[k] = sp(GIT_SPECS[k]);
const WORKTREE_LIST = sp({ bool: "porcelain verbose", eq: "expire", req: "expire", s: "vz" });
const BRANCH_SPEC = sp({ bool: "all remotes verbose show-current list contains no-contains merged no-merged points-at ignore-case no-color color column no-column no-abbrev quiet omit-empty", eq: "color column sort format abbrev contains no-contains merged no-merged points-at", s: "arvliq" });
const TAG_SPEC = sp({ bool: "list contains no-contains merged no-merged points-at ignore-case column no-column color omit-empty", eq: "sort format contains no-contains merged no-merged points-at column color", req: "sort format", s: "li", so: "n" });
const CONFIG_SPEC = sp({ bool: "get get-all get-regexp get-urlmatch get-color get-colorbool list global system local worktree show-origin show-scope null name-only includes no-includes bool int bool-or-int path expiry-date", eq: "type default file blob", req: "file blob default type", s: "lz", sv: "f" });
const REMOTE_SHOW = sp({ s: "n" }), REMOTE_URL = sp({ bool: "push all" });

// Returns { bad: option } or { pos: positionals } for args read against a spec.
function readOpts(spec, args) {
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("="), name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (eq < 0 && spec.bool.has(name)) continue;
      if (eq >= 0 && (spec.eq.has(name) || spec.req.has(name))) continue;
      if (eq < 0 && spec.req.has(name)) { i++; continue; }
      return { bad: a };
    }
    if (a.length > 1 && a.startsWith("-")) {
      if (spec.num && /^-\d+$/.test(a)) continue;
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (spec.sv.includes(ch)) { if (k === a.length - 1) i++; break; }
        if (spec.so.includes(ch)) break;
        if (!spec.s.includes(ch)) return { bad: a };
      }
      continue;
    }
    pos.push(a);
  }
  return { pos };
}

// Returns null when the git subcommand is read-only with these arguments, else the reason.
function gitNotReadOnly(sub, rest) {
  const a = rest.map((w) => w.lit);
  if (a.includes(null)) return "an argument it cannot read before it runs";
  const opt = (spec, args = a) => { const r = readOpts(spec, args); return r.bad !== undefined ? { bad: `option ${r.bad} (not on its read-only list)` } : r; };
  const check = (spec, args = a) => opt(spec, args).bad ?? null;
  if (GIT_SPECS[sub]) {
    const r = opt(GIT_SPECS[sub]);
    if (r.bad) return r.bad;
    if ((sub === "fetch" || sub === "ls-remote") && r.pos.slice(1).some((x) => x.includes(":"))) return "a src:dst refspec (a fetch writes refs)";
    if (sub === "symbolic-ref" && r.pos.length > 1) return "a symbolic-ref update";
    return null;
  }
  if (sub === "worktree") return a[0] === "list" ? check(WORKTREE_LIST, a.slice(1)) : "a worktree change";
  if (sub === "branch") {
    const r = opt(BRANCH_SPEC);
    if (r.bad) return r.bad;
    return r.pos.length && !a.some((x) => /^(-[a-z]*[lar][a-z]*|--list|--all|--remotes|--(no-)?contains.*|--(no-)?merged.*|--points-at.*)$/.test(x)) ? "a branch change" : null;
  }
  if (sub === "tag") {
    const r = opt(TAG_SPEC);
    if (r.bad) return r.bad;
    return r.pos.length && !a.some((x) => /^(-[a-z]*l[a-z]*|--list|--(no-)?contains.*|--(no-)?merged.*|--points-at.*)$/.test(x)) ? "a tag change" : null;
  }
  if (sub === "remote") {
    let i = 0;
    while (a[i] === "-v" || a[i] === "--verbose") i++;
    if (i === a.length) return null;
    if (a[i] === "show") return check(REMOTE_SHOW, a.slice(i + 1));
    if (a[i] === "get-url") return check(REMOTE_URL, a.slice(i + 1));
    return "a remote change";
  }
  if (sub === "config") {
    const r = opt(CONFIG_SPEC);
    if (r.bad) return r.bad;
    const read = a.some((x) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|-[a-z]*l[a-z]*)$/.test(x)) || ["get", "list"].includes(r.pos[0]);
    const n = ["get", "list"].includes(r.pos[0]) ? r.pos.length - 1 : r.pos.length;
    return read && n <= 2 ? null : "a config write";
  }
  if (sub === "reflog") {
    if (a[0] === "exists") return a.length === 2 && !a[1].startsWith("-") ? null : "a reflog change";
    if (["expire", "delete", "drop"].includes(a[0])) return "a reflog change";
    return check(GIT_SPECS.log, a[0] === "show" ? a.slice(1) : a);
  }
  if (sub === "stash") return a[0] === "list" || a[0] === "show" ? check(GIT_SPECS.log, a.slice(1)) : "a stash change";
  if (sub === "notes") {
    if (a[0] !== "show" && a[0] !== "list") return "a notes change";
    const o = a.slice(1).find((x) => x.startsWith("-"));
    return o ? `option ${o} (not on its read-only list)` : null;
  }
  return "a subcommand that is not read-only";
}

// ---------- gh ----------
const GH_GLOBAL_VALUED = ["-R", "--repo", "--hostname"];
const GH_API_VALUED = ["-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "--hostname", "-p", "--preview", "--cache"];
const GH_WRITE_ENDPOINT = /(^|\/)(merges|pulls|merge|refs|contents|git)(\/|$|\?)/;

function ghDeny(args) {
  const pos = [], fields = [];
  let method = null, input = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i].lit;
    if (a === null) { pos.push(args[i]); continue; }
    if (a === "-X" || a === "--method") { method = args[i + 1]?.lit ?? "?"; i++; continue; }
    if (/^(-X|--method=)./.test(a)) { method = a.replace(/^(-X|--method=)/, ""); continue; }
    if (["-f", "-F", "--field", "--raw-field"].includes(a)) { fields.push(args[i + 1] ?? { lit: null }); i++; continue; }
    if (/^(--field|--raw-field)=/.test(a)) { fields.push({ lit: a.replace(/^[^=]*=/, "") }); continue; }
    if (a === "--input" || a.startsWith("--input=")) { input = true; if (a === "--input") i++; continue; }
    if ([...GH_GLOBAL_VALUED, ...GH_API_VALUED].includes(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    pos.push(args[i]);
  }
  const [p0, p1] = pos.map((w) => w.lit);
  if (p0 === "pr" && (p1 === "merge" || p1 === "checkout")) return `run "gh pr ${p1}" (the merge is the verified local --no-ff merge a worker builds)`;
  if (p0 !== "api") return null;
  const endpoint = p1;
  if (endpoint === "graphql") {
    if (input || fields.some((f) => f.lit === null || /\bmutation\b/.test(f.lit) || /^[^=]*=@/.test(f.lit))) return `run a GraphQL mutation, or a query it cannot read (a variable, @file or --input), through "gh api graphql"`;
    return null;
  }
  const m = (method ?? (fields.length || input ? "POST" : "GET")).toUpperCase();
  if (m !== "GET" && m !== "HEAD" && (endpoint == null || GH_WRITE_ENDPOINT.test(endpoint))) return `run "gh api" ${m} on ${endpoint ?? "an endpoint it cannot read"} (merges, pulls, refs and contents change the repo)`;
  return null;
}

// ---------- writers ----------
// Options with a value, per writer; the targets are the positionals (cp, ln, install, rsync: the last one, or -t).
const WRITERS = {
  tee: { opts: [] }, rm: { opts: [] }, rmdir: { opts: [] }, unlink: { opts: [] }, shred: { opts: ["-n", "-s", "--iterations", "--size"] },
  mkdir: { opts: ["-m", "--mode"] }, touch: { opts: ["-d", "-t", "-r", "--date", "--reference"] }, truncate: { opts: ["-s", "-r", "--size", "--reference"] },
  mv: { opts: ["-S", "--suffix"] }, cp: { opts: ["-S", "--suffix"], last: true }, ln: { opts: ["-S", "--suffix"], last: true },
  install: { opts: ["-m", "-o", "-g", "-S", "--mode", "--owner", "--group", "--suffix"], last: true },
  rsync: { opts: ["-e", "--rsh", "--exclude", "--include", "--filter", "-f", "--files-from", "--exclude-from", "--include-from", "--chmod", "--rsync-path"], last: true },
  chmod: { opts: [], skip: 1 }, chown: { opts: [], skip: 1 }, chgrp: { opts: [], skip: 1 },
};
const CWD = { raw: "the current directory", exp: ".", lit: ".", vars: [] };
const val = (w, s) => ({ ...w, raw: w.raw, exp: w.exp === null ? null : w.exp.slice(s), lit: w.lit === null ? null : w.lit.slice(s) });
const FIND_EXEC_WRITERS = new Set([...Object.keys(WRITERS), "sed", "dd", "patch", "truncate"]);

function positionals(args, opts) {
  const pos = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i].lit;
    if (!ended && a === "--") { ended = true; continue; }
    if (!ended && a !== null && a.startsWith("-") && a !== "-") { if (opts.includes(a)) i++; continue; }
    pos.push(args[i]);
  }
  return pos;
}

function writeTargets(name, args) {
  const lits = args.map((w) => w.lit ?? "");
  if (name === "sed") {
    const inPlace = lits.some((a) => /^(-i.*|--in-place.*|-[a-zA-Z]*i[a-zA-Z]*)$/.test(a));
    const pos = [], scripts = [];
    let explicit = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i].lit;
      if (a !== null && /^-[ef]$/.test(a)) { explicit = true; if (a === "-e" && args[i + 1]) scripts.push(args[i + 1]); i++; continue; }
      if (a !== null && /^--(expression|file)/.test(a)) { explicit = true; continue; }
      if (a === "-l") { i++; continue; }
      if (a !== null && a.startsWith("-") && a !== "-") continue;
      pos.push(args[i]);
    }
    if (!explicit && pos.length) scripts.push(pos.shift());
    const writesFile = scripts.some((w) => w.lit === null || /(^|[;{}\s/])[wW]\s+\S/.test(w.lit));
    return [...(inPlace ? pos : []), ...(writesFile ? [CWD] : [])];
  }
  if (name === "awk" || name === "gawk" || name === "mawk") {
    if (lits.some((a) => a === "-i" || a.startsWith("--include") || a === "inplace")) return [CWD];
    const prog = positionals(args, ["-f", "-v", "-F", "--file", "--assign", "--field-separator"])[0];
    return prog && (prog.lit === null || /\b(print|printf)\b[^;}]*>|system\s*\(|\|\s*getline|print[^;}]*\|/.test(prog.lit)) ? [CWD] : [];
  }
  if (name === "patch") {
    const t = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i].lit;
      if ((a === "-d" || a === "--directory" || a === "-o" || a === "--output") && args[i + 1]) { t.push(args[++i]); continue; }
      if (a !== null && /^(-d|-o)./.test(a)) t.push(val(args[i], 2));
    }
    const pos = positionals(args, ["-p", "-i", "-F", "-B", "-z", "-Y", "-V", "-D", "-r", "--input", "--strip", "--fuzz", "--reject-file"]);
    return [...(t.length ? t : [CWD]), ...pos.slice(0, 1)];
  }
  if (name === "dd") return args.filter((w) => w.raw.startsWith("of=")).map((w) => val(w, 3));
  if (name === "curl") {
    const t = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i].lit;
      if (a === null) continue;
      if (a === "-o" || a === "--output" || a === "--output-dir" || (/^-[a-zA-Z]+o$/.test(a))) { if (args[i + 1]) t.push(args[++i]); continue; }
      if (a.startsWith("--output=") || a.startsWith("--output-dir=")) { t.push(val(args[i], a.indexOf("=") + 1)); continue; }
      if (a === "-O" || a === "--remote-name" || a === "--remote-name-all" || /^-[a-zA-Z]*O[a-zA-Z]*$/.test(a)) t.push(CWD);
    }
    return t;
  }
  if (name === "tar") {
    const first = lits[0] ?? "";
    const extract = /^[a-zA-Z]*x/.test(first) && !first.startsWith("-") || lits.some((a) => a === "--extract" || a === "--get" || /^-[a-zA-Z]*x/.test(a));
    if (!extract) return [];
    for (let i = 0; i < args.length; i++) {
      if ((lits[i] === "-C" || lits[i] === "--directory") && args[i + 1]) return [args[i + 1]];
      if (lits[i].startsWith("--directory=")) return [val(args[i], 12)];
    }
    return [CWD];
  }
  if (name === "find") {
    const start = [];
    for (const w of args) { if (w.lit !== null && /^[-(!]/.test(w.lit)) break; start.push(w); }
    const execs = args.flatMap((w, i) => (["-exec", "-execdir", "-ok", "-okdir"].includes(w.lit) ? [args[i + 1]] : []));
    const writes = lits.includes("-delete") || lits.some((a) => /^-fprint/.test(a)) || execs.some((w) => !w || w.lit === null || FIND_EXEC_WRITERS.has(basename(w.lit)));
    return writes ? (start.length ? start : [CWD]) : [];
  }
  const spec = WRITERS[name];
  if (!spec) return [];
  const dirs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].lit;
    if (a === "-t" || a === "--target-directory") { if (args[i + 1]) dirs.push(args[i + 1]); i++; }
    else if (a?.startsWith("--target-directory=")) dirs.push(val(args[i], 19));
  }
  const pos = positionals(args, [...spec.opts, "-t", "--target-directory"]).slice(spec.skip ?? 0);
  if (dirs.length) return spec.last ? dirs : [...dirs, ...pos];
  return spec.last ? pos.slice(-1) : pos;
}

// ---------- DEC-08 ----------
function trailerOk(msg, key) {
  const paras = msg.replace(/\r\n/g, "\n").trim().split(/\n[ \t]*\n/);
  const last = paras.pop().split("\n"), lc = key.toLowerCase();
  const has = (lines, k) => lines.some((l) => l.toLowerCase().startsWith(`${k}:`) && l.slice(k.length + 1).trim());
  return has(last, lc) && !paras.some((p) => has(p.split("\n"), "co-authored-by"));
}

// The literal text of a -m value: a static word, or "$(cat <<'EOF' ... EOF)".
function messageOf(w, cmds) {
  if (!w) return null;
  if (w.lit !== null) return w.lit;
  if (!w.onlySub) return null;
  const [from, to] = w.onlySub;
  const c = cmds.slice(from, to);
  if (c.length !== 1 || c[0].heredoc === null || c[0].words.length !== 1 || c[0].words[0].lit !== "cat") return null;
  return c[0].heredoc.replace(/\n+$/, "");
}

function dec08(sub, rest, dir, cmd, cmds, ctx, st) {
  if (sub !== "merge" && sub !== "commit") return null;
  const prof = ctx.profile(dir);
  if (!prof?.trailer) return null;
  const base = prof.base;
  const msgs = [], files = [], pos = [], flags = new Set();
  const valued = sub === "merge" ? ["-s", "-X", "--strategy", "--strategy-option", "--into-name", "--cleanup"] : ["--author", "--date", "--cleanup", "--fixup", "--squash", "-t", "--template", "--trailer", "--pathspec-from-file"];
  const shortValued = sub === "merge" ? "sX" : "t";
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i], a = w.lit;
    if (a === null) { pos.push(w); continue; }
    if (a === "--") { pos.push(...rest.slice(i + 1)); break; }
    if (a === "--message") { msgs.push(messageOf(rest[++i], cmds)); continue; }
    if (a === "--file") { files.push(rest[++i]?.exp ?? null); continue; }
    if (a.startsWith("--message=")) { msgs.push(a.slice(10)); continue; }
    if (a.startsWith("--file=")) { files.push(a.slice(7)); continue; }
    if (sub === "commit" && /^--(reuse|reedit)-message$/.test(a)) { i++; continue; }
    if (a.startsWith("--")) { flags.add(a.split("=")[0]); if (valued.includes(a)) i++; continue; }
    if (/^-[a-zA-Z]+$/.test(a)) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === "m" || ch === "F" || (sub === "commit" && (ch === "C" || ch === "c")) || shortValued.includes(ch)) {
          const v = a.length > k + 1 ? { lit: a.slice(k + 1), exp: a.slice(k + 1) } : rest[++i];
          if (ch === "m") msgs.push(messageOf(v, cmds));
          else if (ch === "F") files.push(v?.exp ?? null);
          break;
        }
        flags.add(`-${ch}`);
      }
      continue;
    }
    pos.push(w);
  }
  const why = `DEC-08: the merge commit message needs the "${prof.trailer}:" trailer (the reviewer that ran and the review pointer, or "<owner> waived - <reason>") in the same last paragraph as Co-Authored-By`;
  const explicit = `${why}; give the message explicitly: use -F with a message file.`;
  const gdir = dir ?? st.cwd;
  const inMerge = () => {
    if (st.merging) return true;
    const head = gdir && ctx.mergeHead(gdir);
    return !!head && !(base && ctx.baseShas(gdir, base).includes(head));
  };
  if (sub === "merge") {
    if (flags.has("--abort") || flags.has("--quit")) return null;
    if (flags.has("--continue")) return inMerge() ? explicit : null;
    if (!flags.has("--no-ff") || !pos.length) return null;
    const baseRefs = base ? [base, `origin/${base}`, `refs/heads/${base}`, `refs/remotes/origin/${base}`] : [];
    const catchUpRef = (w) => w.lit === "FETCH_HEAD" || baseRefs.includes(w.lit) || (/^[0-9a-f]{7,40}$/.test(w.lit ?? "") && !!base && !!gdir && ctx.baseShas(gdir, base).some((h) => h.startsWith(w.lit)));
    if (pos.every(catchUpRef)) return null;
    if (flags.has("--no-commit")) { st.merging = true; return null; }
  } else {
    if (flags.has("--amend") || !inMerge()) return null;
  }
  if (!msgs.length && !files.length) return explicit;
  const texts = [...msgs];
  for (const f of files) texts.push(f === "-" ? cmd.heredoc : f === null ? null : isAbsolute(f) || dir ? ctx.readFile(isAbsolute(f) ? f : resolve(dir, f)) : null);
  if (texts.some((t) => t === null || t === undefined)) return `${why}; this message cannot be read before it runs: use -F with a message file.`;
  return trailerOk(texts.join("\n\n"), prof.trailer) ? null : `${why}; fix the message file and pass it with -F.`;
}

// ---------- the walk over the commands ----------
const DECLARE = new Set(["export", "declare", "typeset", "local", "readonly"]);
// `$(mktemp)`, `$(mktemp -d)`, `$(mktemp [-d] -t NAME.XXXX)`: a new path in the temp dir. Not -p, --tmpdir or a template path.
export function isMktempAssign(raw) {
  const m = /^[A-Za-z_]\w*=("?)\$\(/.exec(raw);
  if (!m || !raw.endsWith(`)${m[1]}`)) return false;
  const inner = raw.slice(m[0].length, raw.length - 1 - m[1].length).trimStart();
  if (!inner.startsWith("mktemp")) return false;
  const rest = inner.slice("mktemp".length);
  if (rest.trim() === "") return true;
  if (!/^\s/.test(rest)) return false;
  const tokens = rest.trim().split(/\s+/);
  for (let k = 0; k < tokens.length; k++) {
    if (["-d", "-q", "--directory", "--quiet"].includes(tokens[k])) continue;
    if (/^-[dq]*t$/.test(tokens[k]) && /^[\w.-]+$/.test(tokens[k + 1] ?? "")) { k++; continue; }
    return false;
  }
  return true;
}

// Records the variables a command assigns: prefix assignments, export/declare, read, for, mapfile.
function assigns(cmd, r, st) {
  const set = (raw) => {
    const m = isMktempAssign(raw);
    const name = /^[A-Za-z_]\w*/.exec(raw)?.[0];
    if (!name) return;
    st.assigned.add(name);
    if (m) st.temp.add(name); else st.temp.delete(name);
  };
  const w = cmd.words;
  let i = 0;
  while (i < w.length && KEYWORDS.has(w[i].lit)) i++;
  if (w[i]?.lit === "for" || w[i]?.lit === "select") { if (w[i + 1]) set(w[i + 1].raw); return; }
  for (; i < w.length && isAssign(w[i].raw); i++) set(w[i].raw);
  if (!r || r.dynamic) return;
  if (DECLARE.has(r.name)) for (const a of r.args) { if (!a.raw.startsWith("-")) set(a.raw); }
  if (r.name === "read") {
    for (let k = 0; k < r.args.length; k++) {
      const a = r.args[k].raw;
      if (/^-[pdntuN]$/.test(a)) { k++; continue; }
      if (a === "-a") { if (r.args[k + 1]) set(r.args[++k].raw); continue; }
      if (!a.startsWith("-")) set(a);
    }
  }
  if ((r.name === "mapfile" || r.name === "readarray") && r.args.length) set(r.args[r.args.length - 1].raw);
  if (r.name === "printf") for (let k = 0; k < r.args.length; k++) { const a = r.args[k].raw; if (a === "-v" && r.args[k + 1]) set(r.args[++k].raw); else if (/^-v\w/.test(a)) set(a.slice(2)); }
}

const deny = (what) => `OPR-01: the operator session does not ${what}; ${DELEGATE}.`;

function checkCmds(cmds, st, ctx, op, total) {
  for (const cmd of cmds) {
    const r = resolveCmd(cmd.words);
    if (op) {
      for (const { target } of cmd.redirs) { const d = target_(target, st, ctx); if (d) return deny(`write ${d} (shell redirect)`); }
      if (r?.dynamic) return deny("run a command whose program it cannot tell before it runs");
    }
    assigns(cmd, r, st);
    if (!r || r.dynamic) continue;
    if (r.name === "cd" || r.name === "pushd") {
      const t = r.args.find((w) => w.lit === null || !w.lit.startsWith("-") || w.lit === "-");
      const e = t ? expOf(t, st) : st.env.HOME;
      st.cwd = cmd.depth > 0 || st.complex || e == null || e === "-" ? null : isAbsolute(e) ? e : st.cwd && resolve(st.cwd, e);
      continue;
    }
    if (r.name === "popd") { st.cwd = null; continue; }
    if (r.opaque) { if (op) return deny(`run "${r.name}" with a command or script it cannot check (run it via a worker)`); continue; }
    if (r.scripter) { if (op) return deny(`run "${r.name}" with inline code (script writers: delegate to a worker)`); continue; }
    if ("inner" in r) {
      if (r.inner === null) { if (op) return deny(`run ${r.name} with a script it cannot read (run it via a worker)`); continue; }
      let inner;
      try { inner = parseShell(r.inner, st.env); } catch { if (op) return deny(`run a ${r.name} script it cannot parse (run it via a worker)`); continue; }
      // eval runs in this shell (shared cwd and variables); sh -c in a child (a copy).
      const sub = r.name === "eval" ? st : { ...st, assigned: new Set(st.assigned), temp: new Set(st.temp) };
      sub.complex ||= inner.complex;
      const d = checkCmds(inner, sub, ctx, op, total + inner.length);
      if (d) return d;
      continue;
    }
    if (r.name === "git") {
      const g = gitSplit(r.args, st.cwd, op);
      if (g.bad) { if (op) return deny(`run git with ${g.bad}`); continue; }
      if (op && g.config) return deny("run git with -c (a config override can run a program)");
      if (!g.sub) continue;
      const why = op ? gitNotReadOnly(g.sub, g.rest) : null;
      if (!why) {
        const d8 = dec08(g.sub, g.rest, g.dir, cmd, cmds, ctx, st);
        if (d8) return d8;
        continue;
      }
      if (g.sub === "push") {
        const prof = ctx.profile(g.dir);
        const lone = g.rest.length === 2 && g.rest[0].lit === "origin" && prof?.base && g.rest[1].lit === `HEAD:${prof.base}`;
        if (!prof?.base || !prof?.pusher) return deny("push: the profile names no base_pusher (or no base_branch), so the operator pushes nothing; a worker pushes its own branch after your GO");
        if (!lone) return deny(`run "git push ${g.rest.map(shown).join(" ")}"; a worker pushes its own branch after your GO, and the operator pushes only the base, as "git push origin HEAD:${prof.base}"`);
        if (total !== 1) return deny(`chain the base push with other commands (OPR-03: the base is pushed alone)`);
        continue;
      }
      return deny(`run "git ${g.sub}${g.rest.length ? " " + g.rest.map(shown).join(" ") : ""}" (${why})`);
    }
    if (!op) continue;
    if (r.name === "gh") { const d = ghDeny(r.args); if (d) return deny(d); continue; }
    const targets = writeTargets(r.name, r.args);
    if (r.xargs && (targets.length || r.name in WRITERS || r.name === "sed")) return deny(`run "xargs ${r.name}" (its targets are unknown before it runs)`);
    for (const t of targets) { const d = target_(t, st, ctx); if (d) return deny(`write ${d} (${r.name})`); }
  }
  return null;
}

// A word's expansion, or null when it uses a variable this command assigns (its value is unknown here).
const expOf = (w, st) => ((w.vars ?? []).some((v) => st.assigned.has(v)) ? null : w.exp);

// Returns a description when the write target is (or may be) inside a worktree of the repo, else null.
function target_(w, st, ctx) {
  const vs = w.vars ?? [];
  const lead = /^"?\$\{?([A-Za-z_]\w*)\}?(["/]|$)/.exec(w.raw);
  if (lead && st.temp.has(lead[1]) && vs.every((v) => st.temp.has(v)) && !/(^|\/)\.\.(\/|"|$)/.test(w.raw)) return null;
  if (vs.some((v) => st.assigned.has(v))) return `${shown(w)}, a path with a variable set in this command`;
  if (w.exp === null) return `${shown(w)}, a path it cannot resolve before it runs`;
  if (!isAbsolute(w.exp) && !st.cwd) return `${shown(w)} in an unknown directory`;
  const f = real(resolve(st.cwd ?? "/", w.exp));
  if (ctx.operatorFiles.includes(f)) return null;
  return ctx.roots.some((r) => inside(r, f)) ? `${shown(w)} inside the repo` : null;
}

// Returns the deny reason, or null to allow.
export function guard(input, env = {}, ctx = null) {
  const op = isOperator(input, env);
  const tool = input?.tool_name, ti = input?.tool_input ?? {};
  const cwd = typeof input?.cwd === "string" && input.cwd ? resolve(input.cwd) : null;
  const getCtx = () => ctx ?? (ctx = realCtx(cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd(), env));
  if (EDIT_TOOLS.includes(tool)) {
    if (!op) return null;
    const f = ti.file_path ?? ti.notebook_path;
    if (typeof f !== "string" || !f || (!isAbsolute(f) && !cwd)) return `OPR-01: the operator session does not edit a file it cannot locate; ${DELEGATE}.`;
    const abs = real(resolve(cwd ?? "/", f)), c = getCtx();
    if (c.operatorFiles.includes(abs) || !c.roots.some((r) => inside(r, abs))) return null;
    return `OPR-01: the operator session does not edit or write ${f} inside the repo (its one file is .agents/operator.md); ${DELEGATE}.`;
  }
  if (tool !== "Bash") return null;
  if (typeof ti.command !== "string") return op ? `OPR-01: the operator session does not run a Bash call without a command string; ${DELEGATE}.` : null;
  let cmds;
  try { cmds = parseShell(ti.command, env); } catch (e) { return op ? `OPR-01: the operator session does not run a command it cannot parse (${e.message}); ${DELEGATE}.` : null; }
  if (!op && !/\bgit\b/.test(ti.command)) return null;
  return checkCmds(cmds, { cwd, env, assigned: new Set(), temp: new Set(), merging: false, complex: cmds.complex }, getCtx(), op, cmds.length);
}

// The hook entry: raw stdin in, { code, stdout, stderr } out. Fails closed only for the operator.
export function hookMain(raw, env, fn = guard) {
  let input;
  try { input = JSON.parse(raw); } catch {
    if (env.ORBIT_ROLE === "operator") return { code: 2, stdout: "", stderr: "OPR-01: the orbit guard cannot read the hook input, so the operator's tool call is denied.\n" };
    return { code: 0, stdout: "", stderr: "" };
  }
  let reason;
  try { reason = fn(input, env); } catch (e) {
    if (!isOperator(input, env)) return { code: 0, stdout: "", stderr: "" };
    reason = `OPR-01: the orbit guard failed (${e.message}), so the operator's tool call is denied.`;
  }
  const stdout = reason ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n" : "";
  return { code: 0, stdout, stderr: "" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { /* stdin unreadable: treated as empty input, which hookMain handles */ }
  const o = hookMain(raw, process.env);
  process.stdout.write(o.stdout);
  process.stderr.write(o.stderr);
  process.exit(o.code);
}
