// OKF v0.2 per-document checks, shared by validate-okf.mjs (the whole bundle) and intent-plan.mjs (docs not yet
// written). Zero dependencies. checkDoc(text, { maxChars }) returns { errors, warnings, fm, description }: the
// frontmatter, a non-empty type, title and description, status, the trust and provenance fields, timestamps,
// quoting, footnotes against sources, a TL;DR line and the size cap. Links and indexes need the bundle on disk and
// stay in validate-okf.mjs.

import { DATETIME, keyLine, plainValue } from "./rx.mjs";

// Top-level keys of a YAML frontmatter block; values are only needed as strings here.
export function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// Every timestamp key (generated.at, verified.at, stale_after, sources[].last_modified) is an ISO 8601 datetime
// with an explicit UTC offset; usage_window's from and to are checked in checkTrust.
export { DATETIME };
function checkTimestamps(r, block) {
  for (const m of block.matchAll(/(?:^|[\s{,])(at|stale_after|last_modified):\s*["']?([^,}"'\s]+)/gm)) {
    if (!DATETIME.test(m[2])) r.fail(`${m[1]} '${m[2]}' is not an ISO 8601 datetime with a UTC offset`);
  }
}

// A plain (unquoted) YAML value may not hold ': ' or ' #': YAML reads them as a nested key or a comment. Quote such values.
function checkPlainScalars(r, block) {
  for (const line of block.split("\n")) {
    const value = plainValue(line);
    if (value !== null && !/^["'[{|>&*!]/.test(value) && /: | #/.test(value)) r.fail(`quote the value of '${line.trim()}' (': ' or ' #' in a plain YAML value)`);
  }
}

// A small YAML reader for the frontmatter (zero dependencies): block mappings and sequences nested by indentation,
// flow mappings and sequences (`{ k: v }`, `[a, b]`, nested), quoted and plain scalars, block scalars (`|`, `>`),
// comments and blank lines. It never throws; what it cannot read stays a string. Enough for OKF's fields.
const unquote = (s) => {
  s = s.trim();
  if (/^".*"$/s.test(s)) return s.slice(1, -1).replace(/\\"/g, '"');
  if (/^'.*'$/s.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  return s;
};
const stripComment = (s) => {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") { if (i === 0 || /[\s[{,:]/.test(s[i - 1])) q = c; }
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
};
function parseFlow(s) {
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const scalar = (stops) => {
    ws();
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i++]; let out = "";
      while (i < s.length) {
        if (s[i] === q && q === "'" && s[i + 1] === "'") { out += "'"; i += 2; continue; }
        if (s[i] === "\\" && q === '"') { out += s[i + 1] ?? ""; i += 2; continue; }
        if (s[i] === q) { i++; break; }
        out += s[i++];
      }
      return out;
    }
    let out = "";
    while (i < s.length && !stops.includes(s[i]) && !(s[i] === ":" && /\s/.test(s[i + 1] ?? " ") && stops.includes(":"))) out += s[i++];
    return out.trim();
  };
  const value = (stops) => {
    ws();
    if (s[i] === "{") {
      i++; const m = {};
      for (ws(); i < s.length && s[i] !== "}"; ws()) {
        const k = scalar([":", ",", "}"]); ws();
        if (s[i] === ":") { i++; m[k] = value([",", "}"]); } else m[k] = "";
        ws(); if (s[i] === ",") i++;
      }
      i++; return m;
    }
    if (s[i] === "[") {
      i++; const a = [];
      for (ws(); i < s.length && s[i] !== "]"; ws()) { a.push(value([",", "]"])); ws(); if (s[i] === ",") i++; }
      i++; return a;
    }
    return scalar(stops);
  };
  const v = value([]);
  ws();
  return i >= s.length ? v : unquote(s);
}
const scalarValue = (s) => (/^\s*[[{]/.test(s) ? parseFlow(s.trim()) : unquote(s));
export function parseYaml(block) {
  const raw = block.split("\n");
  const L = [];
  for (let r = 0; r < raw.length; r++) {
    const text = stripComment(raw[r]).replace(/\s+$/, "");
    if (text.trim()) L.push({ ind: text.length - text.trimStart().length, text: text.trimStart(), r });
  }
  const isItem = (l) => /^-(\s|$)/.test(l.text);
  let i = 0;
  // A block scalar after `key: |` or `key: >` takes every following raw line indented deeper than `ind`.
  const blockScalar = (ind, style) => {
    const parts = [];
    while (i < L.length && L[i].ind > ind) parts.push(raw[L[i++].r].trim());
    return parts.join(style.startsWith(">") ? " " : "\n");
  };
  const block_ = (ind) => (i < L.length && isItem(L[i]) && L[i].ind === ind ? seq(ind) : map(ind));
  function map(ind) {
    const m = {};
    while (i < L.length && L[i].ind === ind && !isItem(L[i])) {
      const kv = keyLine(L[i].text);
      if (!kv) { i++; continue; }
      const key = unquote(kv[1]), rest = kv[2] ?? "";
      i++;
      if (/^[|>][-+]?\d*$/.test(rest)) m[key] = blockScalar(ind, rest);
      else if (rest) m[key] = scalarValue(rest);
      else if (i < L.length && (L[i].ind > ind || (L[i].ind === ind && isItem(L[i])))) m[key] = block_(L[i].ind);
      else m[key] = "";
    }
    return m;
  }
  function seq(ind) {
    const a = [];
    while (i < L.length && L[i].ind === ind && isItem(L[i])) {
      const content = L[i].text.replace(/^-\s*/, "");
      if (!content) { i++; a.push(i < L.length && L[i].ind > ind ? block_(L[i].ind) : ""); continue; }
      if (!/^[[{"']/.test(content) && keyLine(content)) {
        // `- k: v` opens a mapping whose keys sit at the column of `k`.
        L[i] = { ...L[i], ind: ind + L[i].text.length - content.length, text: content };
        a.push(map(L[i].ind));
      } else { a.push(scalarValue(content)); i++; }
    }
    return a;
  }
  const out = i < L.length ? block_(L[0].ind) : {};
  return out && typeof out === "object" && !Array.isArray(out) ? out : {};
}

// OKF v0.2 trust and provenance (SPEC §5): `generated` needs `by`; every `verified` entry (a list, or a bare
// mapping read as a one-element list) needs `by` and `at`; every `sources` entry needs a `resource`; usage_window
// bounds are datetimes. Warnings only: an actor off the §7 convention (generated.by and verified.by; never a
// source's `author`, which may be e.g. `team:x`), and a human-verified doc that still says `status: draft`
// (§5.4: not yet reviewed).
const ACTOR = /^(human:\S+|process:\S+|[^\s:/]+\/\S+)$/;
export const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function checkTrust(r, block, status) {
  const f = parseYaml(block);
  if ("generated" in f) {
    if (!isMap(f.generated) || !f.generated.by) r.fail("generated needs `by` (an actor)");
    else if (!ACTOR.test(f.generated.by)) r.warn(`generated.by '${f.generated.by}' does not follow the actor convention (<producer>/<version>, human:<id> or process:<id>)`);
  }
  if ("verified" in f) {
    const list = Array.isArray(f.verified) ? f.verified : [f.verified];
    if (!list.length) r.fail("verified is empty");
    for (const v of list) {
      if (!isMap(v) || !v.by || !v.at) r.fail("each verified entry needs `by` and `at`");
      else if (!ACTOR.test(v.by)) r.warn(`verified.by '${v.by}' does not follow the actor convention (<producer>/<version>, human:<id> or process:<id>)`);
    }
    if (status === "draft" && list.some((v) => isMap(v) && /^human:/.test(v.by ?? ""))) r.warn("status draft means not yet reviewed, but a human verified it; set status stable");
  }
  const windows = [f.usage_window];
  if ("sources" in f) {
    if (!Array.isArray(f.sources)) r.fail("sources must be a list");
    else f.sources.forEach((s, i) => {
      if (!isMap(s) || !s.resource) r.fail(`sources entry ${(isMap(s) && s.id) || i + 1} needs a resource`);
      if (isMap(s)) windows.push(s.usage_window);
    });
  }
  for (const w of windows.filter((w) => w !== undefined)) {
    if (!isMap(w)) { r.fail("usage_window needs { from, to }"); continue; }
    for (const k of ["from", "to"]) if (!DATETIME.test(w[k] ?? "")) r.fail(`usage_window.${k} '${w[k] ?? ""}' is not an ISO 8601 datetime with a UTC offset`);
  }
}

// Footnotes join on sources[].id: each one cited has a definition and a source, and each source is cited.
function checkFootnotes(r, block, body) {
  const sources = parseYaml(block).sources;
  const ids = new Set((Array.isArray(sources) ? sources : []).filter((s) => isMap(s) && s.id).map((s) => s.id));
  const prose = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const defs = new Set([...prose.matchAll(/^\[\^([^\]]+)\]:/gm)].map((m) => m[1]));
  const refs = new Set([...prose.replace(/^\[\^[^\]]+\]:/gm, "").matchAll(/\[\^([^\]]+)\]/g)].map((m) => m[1]));
  for (const ref of refs) {
    if (!defs.has(ref)) r.fail(`footnote [^${ref}] has no definition`);
    if (!ids.has(ref)) r.fail(`footnote [^${ref}] matches no sources id`);
  }
  for (const id of ids) if (!refs.has(id)) r.fail(`source '${id}' is never cited`);
}

export function checkDoc(text, { maxChars = 4000 } = {}) {
  const errors = [], warnings = [];
  const r = { fail: (m) => errors.push(m), warn: (m) => warnings.push(m) };
  const fm = frontmatter(text);
  if (!fm) return { errors: ["missing frontmatter"], warnings, fm: null, description: "" };
  const block = text.match(/^---\n([\s\S]*?)\n---\n/)[1];
  checkTimestamps(r, block);
  checkPlainScalars(r, block);
  checkFootnotes(r, block, text.slice(block.length + 8));
  checkTrust(r, block, fm.status);
  for (const key of ["type", "title", "description"]) {
    if (!fm[key]?.trim()) r.fail(`frontmatter needs a non-empty '${key}'`);
  }
  if (fm.status && !["draft", "stable", "deprecated"].includes(fm.status)) r.fail(`status '${fm.status}' is not draft, stable or deprecated`);
  if (!/^\*\*TL;DR:\*\*/m.test(text)) r.fail("missing a '**TL;DR:**' line");
  if (text.length > maxChars) r.fail(`${text.length} chars exceeds ${maxChars}; split it`);
  const parsed = parseYaml(block).description;
  return { errors, warnings, fm, description: (typeof parsed === "string" ? parsed : fm.description ?? "").trim() };
}
