// Shared JSDoc types for the hooks and scripts; checked by `tsc -p .` (make quality), never loaded at runtime. They live outside
// hooks/ and scripts/ because the manifest ties every file there to the rules version.
// In a .mjs file: /** @param {import("../types/orbit.d.ts").ParsedShell} cmds */ (path relative to the file).

/** One shell word as parseShell reads it (hooks/guard.mjs). */
export interface Word {
  /** The literal text; null when the word is dynamic (an expansion, a substitution). */
  lit: string | null;
  /** The text with variables expanded where known; null when it cannot be. */
  exp: string | null;
  raw: string;
  glob: boolean;
  ext: boolean;
  subs: unknown[];
  vars: string[];
  onlySub: unknown | null;
}

/** A redirection that writes (or reads): the operator and the target word. */
export interface Redir { op: string; target: Word }

/** One simple command of a parsed script. */
export interface Cmd {
  words: Word[];
  redirs: Redir[];
  /** The heredoc body, or null when there is none. */
  heredoc: string | null;
  /** Nesting depth: 0 at the top level, more inside a subshell or a substitution. */
  depth: number;
}

/** The shell parser's result: its commands, flagged complex when a cd's effect is unknown. */
export type ParsedShell = Cmd[] & { complex: boolean };

/** A command resolved through its wrappers; `inner` (when present) is the script text a -c, eval or similar runs, null when unreadable. */
export interface ResolvedCmd { name: string; args: Word[]; inner?: string | null }

/** The guard's decision: null allows, a string denies with that reason, { ask } asks the owner with that reason. */
export type GuardDecision = null | string | { ask: string };

/** The hook input the guard reads from stdin. */
export interface HookInput {
  session_id?: string;
  agent_id?: string | null;
  agent_type?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

/** The unattended go (hooks/go.mjs): opened and until are epoch milliseconds. */
export interface GoState { opened: number; until: number }
