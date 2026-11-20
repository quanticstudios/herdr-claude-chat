// The contract between the data side (source.js, model.js) and the renderers.
// Change it only additively; a breaking change goes through the orchestrator.

export interface ImageRef {
  /** Absolute path of a file the source wrote (decoded base64), or null until loaded on demand. */
  path: string | null;
  /** Where to ask the source for it when path is null: transcript byte offset of its line. */
  at?: number;
  media: string; // "image/png"
  /** The [Image #N] number the composer and the user's text use. */
  n?: number;
}

/** A field the source cut to keep messages small: head and tail kept, the rest loads on expand. */
export interface Clipped {
  head: string;
  tail: string;
  /** Size of the whole text in bytes. */
  bytes: number;
  /** Transcript byte offset of the line holding the full text, for source.full(). */
  at: number;
}
export type Text = string | Clipped;

export interface Base {
  /** Stable across re-reads: the line's uuid, a tool_use id, or a derived key. */
  id: string;
  /** ms since epoch. */
  at: number;
}

export type Item =
  /** What the person sent. pasted: `<pasted_content>` blocks pulled out of text. queued: sent mid-turn. */
  | (Base & { kind: "user"; text: string; images: ImageRef[]; pasted: { text: string; lines: number }[]; queued?: boolean })
  /** A slash command: `<command-name>` + `<command-args>`, with `<local-command-stdout>` as output. */
  | (Base & { kind: "command"; name: string; args: string; output?: string })
  /** Claude's prose, markdown. streaming: still growing. */
  | (Base & { kind: "reply"; text: string; streaming?: boolean })
  /** text null: redacted. seconds: how long it thought, when known. */
  | (Base & { kind: "thinking"; text: string | null; seconds?: number })
  /** Every tool call. Task/Agent/Workflow carry their nested calls in children. */
  | (Base & {
      kind: "tool";
      name: string; // "Edit", "Bash", "mcp__linear__get_issue", ...
      input: Record<string, any>;
      status: "running" | "done" | "error" | "denied";
      result?: { text: Text; images: ImageRef[]; isError: boolean };
      seconds?: number;
      /** run_in_background shells: BashOutput/KillShell attach here instead of new rows. */
      background?: { shellId: string; running: boolean; output?: Text };
      children?: Item[];
      /** Edit/MultiEdit/Write: toolUseResult.structuredPatch as is, for the diff's line numbers. */
      patch?: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[];
      /** Write: toolUseResult.type was "create". */
      created?: boolean;
    })
  /** The plan: one per transcript, updated in place (TodoWrite, TaskCreate/TaskUpdate). */
  | (Base & { kind: "todo"; items: { text: string; activeText?: string; status: "pending" | "in_progress" | "completed" }[] })
  /** Quiet system rows: interrupts, compaction, background task finished, API errors, "Continued in the terminal". */
  | (Base & {
      kind: "notice";
      tone: "muted" | "info" | "warn" | "error";
      text: string;
      /** How system.js draws it; without it, system.js guesses from the text. warn + limit: usage or rate limit. */
      what?: "interrupt" | "compact" | "task" | "hook" | "switch" | "api" | "limit";
      /** Expandable body: the compaction summary, a hook's message, an API error's details. */
      detail?: Text;
    })
  /** End of a turn, for spacing and the turn's time. tokens and cost when known; hover shows the breakdown. */
  | (Base & {
      kind: "turn";
      seconds?: number;
      tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
      cost?: number;
    });

/** Tools system.js draws; tools.js draws every other tool. */
export const SYSTEM_TOOLS: readonly string[];

/** What every renderer gets besides its item. */
export interface Ctx {
  /** theme.js tokens. */
  t: import("./theme.js").Tokens;
  /** The chat's folder: show paths relative to it. */
  cwd: string;
  /** Collapsed/expanded state, per item id (and sub-keys like `${id}:out`). */
  open(key: string): boolean;
  toggle(key: string): void;
  /** Opens a file at a line the way herdr opens files (the files panel / $EDITOR). */
  openFile(path: string, line?: number): void;
  openUrl(url: string): void;
  copy(text: string): void;
  /** Asks the source for a Clipped field's full text; re-renders when it arrives. */
  full(c: Clipped): string | null;
  /** Re-render. */
  notify(): void;
}
