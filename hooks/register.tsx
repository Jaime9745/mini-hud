// Based on sub-meter by midudev (MIT): https://github.com/midudev/better-claude
import { atom, read, update } from "claude-code";
import type {
  Elements,
  EngineInterface,
  Register,
  RenderNode,
  RenderViewport,
  SessionContextUsage,
  SessionRateLimit,
} from "claude-code";

import type { Fill, Git, Limit } from "../types";

const limits = atom(
  { plugin: "mini-hud", key: "limits" } as const,
  [] as Limit[],
);
const view = atom({ plugin: "mini-hud", key: "view" } as const, 0); // which window the rotating meter shows
const tick = atom({ plugin: "mini-hud", key: "tick" } as const, 0); // redraws the countdown
const model = atom({ plugin: "mini-hud", key: "model" } as const, "");
const effort = atom({ plugin: "mini-hud", key: "effort" } as const, "");
const git = atom({ plugin: "mini-hud", key: "git" } as const, null as Git);
const context = atom(
  { plugin: "mini-hud", key: "context" } as const,
  null as Fill,
);

const contextColor = (percent: number) =>
  percent >= 75 ? "error" : percent >= 50 ? "warning" : "claude";
/** The last segment of a path, either separator. */
export const folderOf = (path: string) =>
  path.split(/[/\\]/).filter(Boolean).pop() ?? path;

let lastGit = "";
let isReadingGit = false;

/**
 * The session's folder and, in a git repository, its branch (a worktree's own) and whether it has
 * uncommitted changes, as claude-hud shows them by default. Read on a timer, not per drawing.
 */
async function syncGit($: EngineInterface) {
  if (isReadingGit) return;
  isReadingGit = true;
  try {
    const cwd = await $.session.cwd();
    // One process for branch and changes: `# branch.head <name>` lines, then one line per change.
    const status = await $.process.run(
      ["git", "--no-optional-locks", "status", "--porcelain=v2", "--branch"],
      { cwd, timeoutMs: 1000 },
    );
    const lines = status.exitCode === 0 ? status.stdout.split("\n") : [];
    const head =
      lines
        .find((line) => line.startsWith("# branch.head "))
        ?.slice(14)
        .trim() ?? "";
    const branch = head === "(detached)" ? "HEAD" : head;
    const next: Git = {
      folder: folderOf(cwd),
      branch,
      isDirty: lines.some((line) => line !== "" && !line.startsWith("#")),
    };
    const key = JSON.stringify(next);
    if (key === lastGit) return;
    lastGit = key;
    await update($, git, () => next);
  } finally {
    isReadingGit = false;
  }
}

/** Cells of a 10-cell bar a fill takes, 0 to 10. */
export const cellsFor = (percent: number) =>
  Math.round((Math.min(Math.max(percent, 0), 100) / 100) * 10);

// The compaction window (autoCompactWindow, or the model's own) and the model it was read for.
let compactTokens = 0;
let compactFor = "";
let lastFill: Fill = null;
let isCounting = false;

/**
 * The fill against the window autocompact measures, as /context does: the engine's own `percent` is
 * against the model's whole window. The window is read once per model (a local estimate, no request),
 * and the fill is that estimate until a response reports tokens.
 */
async function syncContext($: EngineInterface, usage: SessionContextUsage) {
  if (isCounting) return;
  let estimate: number | undefined;
  if (compactFor !== lastSessionModel || usage.tokens === undefined) {
    isCounting = true;
    try {
      const { breakdown } = (await $.session.usage({ breakdown: "summary" }))
        .context;
      if (breakdown) {
        compactTokens = breakdown.rawMaxTokens;
        compactFor = lastSessionModel;
        estimate = breakdown.percentage;
      }
    } finally {
      isCounting = false;
    }
  }
  const max = compactTokens || usage.window;
  const value =
    usage.tokens !== undefined && max > 0
      ? (usage.tokens / max) * 100
      : estimate;
  const fill: Fill =
    value === undefined
      ? null
      : { value, isEstimate: usage.tokens === undefined };
  if (
    lastFill?.value === fill?.value &&
    lastFill?.isEstimate === fill?.isEstimate
  )
    return;
  lastFill = fill;
  await update($, context, () => fill);
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-5-20250929[1m]" → "Sonnet 4.5 1M", "opus" → "Opus". */
export function prettyModel(id: string) {
  const m =
    /^(?:claude-)?([a-z]+)(?:-(\d+))?(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(
      id,
    );
  if (!m) return id;
  const [, word = "", major, minor, big] = m;
  return (
    word.charAt(0).toUpperCase() +
    word.slice(1) +
    (major ? ` ${major}` : "") +
    (minor ? `.${minor}` : "") +
    (big ? " 1M" : "")
  );
}

let lastModel = "";
let lastEffort = "";
let lastSessionModel = "";

/** Writes model and effort only when they change, so each request does not redraw the footer. */
async function showModel($: EngineInterface, id: string, level: string) {
  const name = prettyModel(id);
  const writes: Promise<unknown>[] = [];
  if (name !== lastModel) {
    lastModel = name;
    writes.push(update($, model, () => name));
  }
  if (level !== lastEffort) {
    lastEffort = level;
    writes.push(update($, effort, () => level));
  }
  await Promise.all(writes);
}

const WINDOWS = ["five_hour", "seven_day"];
const LABELS: Record<string, string> = { five_hour: "5h", seven_day: "week" };
const ROTATE_SECONDS = 8;
const TICK_MS = 8000;
const DISPLAYS = ["rotate", "both", "session", "week"];
// Where the HUD draws: in the footer row beside the mode label, on a row of its own under it, or in
// the band over the prompt.
const POSITIONS = ["footer", "below", "above"];
const WINDOW_OF: Record<string, string> = {
  session: "five_hour",
  week: "seven_day",
};
const CELLS = 10;
const CYCLE_HINT = /\s*\([^()]+ to cycle\)/;
const INTERRUPT_HINT = /\s*esc to interrupt/;
// The terminal footer's row: two columns of padding at each end, the mode label at the left
// (MODE_ROW) and the hint after it, two columns at least between that and what is drawn here.
const FOOTER_PADDING = 4;
const FOOTER_GAP = 2;
const SEPARATOR = " · ";
const BETWEEN = "  |  ";

// Columns, as last drawn on the terminal, of the engine's hint after the left part and of what is
// beneath the meter (mode labels, another plugin's drawing): each hook tells the other.
let hintWidth = 0;
let beneathWidth = 0;
let lastHint = "";
let lastTidied = "";
let windowCount = 0;
let tickTimer: { cancel: () => void } | undefined;
let rotateTimer: { cancel: () => void } | undefined;

/** The subscription windows the meter shows, in order, from what the engine measured. */
const windowsOf = (rateLimits: readonly SessionRateLimit[]): Limit[] =>
  WINDOWS.flatMap((kind) => {
    const found = rateLimits.find((limit) => limit.kind === kind);
    return found
      ? [{ kind, percentUsed: found.percentUsed, resetsAt: found.resetsAt }]
      : [];
  });

/** Whether a drawing beneath shows nothing: no text, no control (the engine's own node draws `modes`, counted apart). */
function isBlank(node: RenderNode | undefined): boolean {
  if (node === undefined || node === null) return true;
  if (typeof node === "string") return node.trim() === "";
  if (node.type === "engine") return true;
  return (
    (node.type === "Box" || node.type === "Text") &&
    (node.children ?? []).every(isBlank)
  );
}

/** Columns a text takes: one per character, none for a variation selector. */
const widthOf = (text: string) =>
  [...text.replace(/[\uFE0E\uFE0F]/g, "")].length;

/** Columns a drawing beneath takes on one row; the engine's own node draws `modes`, joined by ` & `. */
function widthOfNode(
  node: RenderNode | undefined,
  modes: readonly string[],
): number {
  if (node === undefined || node === null) return 0;
  if (typeof node === "string") return widthOf(node);
  if (node.type === "engine") return widthOf(modes.join(" & "));
  return (node.children ?? []).reduce(
    (sum, child) => sum + widthOfNode(child, modes),
    0,
  );
}

// What the engine draws before the left part, measured on the terminal: `⏵⏵ bypass permissions on · `.
// shortcut: no API names the permission mode, so the longest label is reserved; other modes get spare room.
const MODE_ROW = 27;
// Longest folder or branch name drawn whole.
const NAME_MAX = 20;

/** A text cut to `max` columns, ending in `…` when cut. */
export const cut = (text: string, max: number) =>
  widthOf(text) <= max ? text : [...text].slice(0, max - 1).join("") + "…";

/** What the left part can show, already formatted; `value` is the context fill, for its color. */
export type Left = {
  name: string;
  level: string;
  folder: string;
  branch: string;
  percent: string;
  filled: number;
  value: number;
};
/** One window of the usage meter, formatted. */
export type Meter = {
  kind: string;
  label: string;
  percent: number;
  filled: number;
  used: string;
  reset: string;
};

// Where the row is short it gives up, in this order, one more piece per step: the usage meter goes
// last of all, git before it. With both windows shown, the one nearest its limit stays.
const GIVE_UP = [
  "hasContextBar",
  "hasMeterBar",
  "hasBothWindows",
  "hasFolder",
  "hasReset",
  "hasBranch",
  "hasEffort",
  "hasContext",
  "hasModel",
  "hasMeter",
] as const;
export type Step = Record<(typeof GIVE_UP)[number], boolean>;
const STEPS: Step[] = Array.from(
  { length: GIVE_UP.length + 1 },
  (_, i) => Object.fromEntries(GIVE_UP.map((key, j) => [key, j >= i])) as Step,
);

const barOf = (filled: number) =>
  "━".repeat(filled) + "─".repeat(CELLS - filled);

/** The left part's pieces as text for a step, joined by SEPARATOR when drawn. */
function partsOf(left: Left, step: Step) {
  const { name, level, folder, branch, percent, filled } = left;
  const git = step.hasBranch && branch ? `git:(${branch})` : "";
  const where = [
    step.hasFolder || (step.hasBranch && !branch) ? folder : "",
    git,
  ]
    .filter(Boolean)
    .join(" ");
  const fill =
    step.hasContext && percent
      ? `ctx ${step.hasContextBar ? barOf(filled) + " " : ""}${percent}`
      : "";
  return [
    step.hasModel ? name : "",
    step.hasEffort ? level : "",
    where,
    fill,
  ].filter(Boolean);
}

/** The meter's windows for a step: none, all, or the one nearest its limit. */
export function windowsFor(meter: Meter[], step: Step) {
  if (!step.hasMeter) return [];
  if (step.hasBothWindows || meter.length < 2) return meter;
  return [meter.reduce((top, w) => (w.percent > top.percent ? w : top))];
}

/** The meter as text for a step. */
const meterText = (meter: Meter[], step: Step) =>
  windowsFor(meter, step)
    .map(
      (w) =>
        w.label +
        (step.hasMeterBar ? " " + barOf(w.filled) : "") +
        w.used +
        (step.hasReset ? w.reset : ""),
    )
    .join(BETWEEN);

/**
 * The first step whose row fits in `room` columns: the left part, the engine's hint after it, a gap,
 * the meter and what is beneath it. Both hooks ask it with the same values, so both draw the same step.
 */
export function fitRow(
  left: Left,
  meter: Meter[],
  room: number,
  hint = 0,
  beneath = 0,
): Step {
  return (
    STEPS.find((step) => {
      const ours = widthOf(partsOf(left, step).join(SEPARATOR));
      const right = widthOf(meterText(meter, step));
      const after = hint > 0 ? hint + (ours > 0 ? SEPARATOR.length : 0) : 0;
      const end =
        beneath > 0 ? beneath + (right > 0 ? SEPARATOR.length : 0) : 0;
      return (
        ours + after + (right + end > 0 ? FOOTER_GAP : 0) + right + end <= room
      );
    }) ?? (STEPS[GIVE_UP.length] as Step)
  );
}

/** Columns the footer has on the terminal after the mode label; elsewhere, no limit. */
function roomOf(e: { surface: string; viewport?: RenderViewport }) {
  if (e.surface !== "terminal" || e.viewport === undefined) return Infinity;
  return e.viewport.columns - FOOTER_PADDING - MODE_ROW;
}

const colorFor = (percent: number) =>
  percent >= 90 ? "error" : percent >= 75 ? "warning" : "claude";

/** "42m", "3h 5m", "2d 4h": how long until the window resets. */
function until(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// When the reading this session shows was taken; the shared store carries the newest one of any session.
let seenAt = 0;

/** Keeps the latest reading for the meter, and for the next session until a response reports again. */
let lastLimits = "";

async function remember($: EngineInterface, found: Limit[]) {
  if (found.length === 0) return;
  const key = JSON.stringify(found);
  if (key === lastLimits) return;
  lastLimits = key;
  const [now] = await Promise.all([
    $.clock.now(),
    update($, limits, () => found),
  ]);
  seenAt = now;
  windowCount = found.length;
  // Not waited on: nothing drawn depends on it. `at` after the limits, so a reader that sees the new time finds the new limits.
  void $.store
    .set("limits", found)
    .then(() => $.store.set("at", now))
    .catch(() => {});
}

/** Adopts the reading another session left in the shared store, when it is newer than ours. */
async function syncFromStore($: EngineInterface) {
  const at = Number(await $.store.get("at")) || 0;
  if (at <= seenAt) return;
  const saved = await $.store.get("limits");
  if (!Array.isArray(saved)) return;
  seenAt = at;
  windowCount = saved.length;
  await update($, limits, () => saved as Limit[]);
}

/** The windows to draw: all of them, the one the rotation is on, or the one chosen. With fewer than two readings, whatever there is. */
function visible(all: Limit[], display: string, index: number): Limit[] {
  if (display === "both" || all.length < 2) return all;
  if (display === "rotate") return all.slice(index % all.length).slice(0, 1);
  return all.filter((limit) => limit.kind === WINDOW_OF[display]);
}

/** Which pieces the options turn on, and how the meter displays. */
type Show = {
  model: boolean;
  effort: boolean;
  git: boolean;
  context: boolean;
  usage: boolean;
  display: string;
};

/**
 * What the whole row shows, read by both drawings: the left part and the meter. Reading it subscribes
 * the drawing to every value, so a change on either side redraws both and they agree on the step.
 */
async function rowOf(
  $: EngineInterface,
  show: Show,
): Promise<{ left: Left; meter: Meter[] }> {
  // `view` in the same round: read after, it cost a second round trip per drawing.
  const [shownName, shownLevel, shownFill, shownGit, all, , now, shownView] =
    await Promise.all([
      read($, model),
      read($, effort),
      read($, context),
      read($, git),
      read($, limits),
      read($, tick),
      $.clock.now(),
      show.usage && show.display === "rotate" ? read($, view) : 0,
    ]);
  const repo = show.git ? shownGit : null;
  const fill = show.context ? shownFill : null;
  const left: Left = {
    name: show.model ? shownName : "",
    level: show.effort ? shownLevel : "",
    folder: repo === null ? "" : cut(repo.folder, NAME_MAX),
    branch: repo?.branch
      ? cut(repo.branch, NAME_MAX) + (repo.isDirty ? "*" : "")
      : "",
    percent:
      fill === null
        ? ""
        : `${fill.isEstimate ? "~" : ""}${Math.round(fill.value)}%`,
    filled: fill === null ? 0 : cellsFor(fill.value),
    value: fill === null ? 0 : fill.value,
  };
  if (!show.usage || all.length === 0) return { left, meter: [] };
  const index = all.length >= 2 ? shownView : 0;
  const meter = visible(all, show.display, index).map((limit) => {
    const resetsIn =
      limit.resetsAt === undefined
        ? undefined
        : Date.parse(limit.resetsAt) - now;
    const hasReset = resetsIn !== undefined && resetsIn <= 0;
    const percent = hasReset ? 0 : limit.percentUsed;
    return {
      kind: limit.kind,
      label: LABELS[limit.kind] ?? limit.kind,
      percent,
      filled: cellsFor(percent),
      used: ` ${Math.round(percent)}%`,
      reset: resetsIn !== undefined && !hasReset ? ` ↻ ${until(resetsIn)}` : "",
    };
  });
  return { left, meter };
}

let isInteractive = false;
// The effort the settings gave when last read: shown only when it changes there, so a request's
// own effort (turn.step, after any downgrade for the model) is not overwritten on every tick.
let lastSettingsEffort = "";

/** The effort the settings give a model: its own (`/effort` writes it there), else the global one. */
const effortOf = (perModel: unknown, level: unknown, id: string) =>
  String(
    (perModel as Record<string, { effortLevel?: unknown }> | undefined)?.[id]
      ?.effortLevel ??
      level ??
      "",
  );

/** Model and effort as the session and the settings have them now: after /model or /effort, and on each tick. */
async function syncChoice($: EngineInterface) {
  const [id, perModel, level] = await Promise.all([
    $.session.model(),
    $.settings.read({ key: "modelSettings" }),
    $.settings.read({ key: "effortLevel" }),
  ]);
  const effort = effortOf(perModel, level, id);
  if (id === lastSessionModel && effort === lastSettingsEffort) return;
  lastSessionModel = id;
  lastSettingsEffort = effort;
  await showModel($, id, effort);
}

/** Fills the footer for a session that starts (or a /clear) and starts its timers. */
async function start($: EngineInterface, show: Show, rotateMs: number) {
  tickTimer?.cancel();
  tickTimer = undefined;
  rotateTimer?.cancel();
  rotateTimer = undefined;
  lastGit = "";
  isReadingGit = false;
  if (show.git) void syncGit($).catch(() => {}); // first, and not waited on: the session starts at once
  lastLimits = "";
  // Every read in one round trip.
  const [saved, storedAt, usage, sessionModel, perModel, level] =
    await Promise.all([
      $.store.get("limits"),
      $.store.get("at"),
      $.session.usage(),
      $.session.model(),
      $.settings.read({ key: "modelSettings" }),
      $.settings.read({ key: "effortLevel" }),
    ]);
  seenAt = Number(storedAt) || 0;
  const found = windowsOf(usage.rateLimits);
  if (found.length === 0 && Array.isArray(saved)) {
    windowCount = saved.length;
    await update($, limits, () => saved as Limit[]);
  }

  // Before the first request: the session's model, and the effort the settings give it.
  lastModel = lastEffort = "";
  lastSessionModel = sessionModel;
  lastSettingsEffort = effortOf(perModel, level, sessionModel);
  compactFor = "";
  lastFill = null;
  isCounting = false;
  await Promise.all([
    remember($, found),
    showModel($, lastSessionModel, lastSettingsEffort),
  ]);
  // The window estimate is not waited on either: the fill shows when it is in.
  void syncContext($, usage.context).catch(() => {});

  if (!isInteractive) return;
  // Another session's reading shows up within TICK_MS of being stored.
  tickTimer = $.clock.every(TICK_MS, () => {
    void refill($, show, rotateMs).catch(() => {});
    void syncFromStore($).catch(() => {}); // a failed read keeps the reading on screen
    // A /model or /effort the command hook missed (a picker still open when it ran).
    void syncChoice($).catch(() => {});
    // A resume, a rewind, a compaction or a /model switch moves the fill without a measurement.
    void $.session
      .usage()
      .then((usage) => syncContext($, usage.context))
      .catch(() => {});
    if (show.git) void syncGit($).catch(() => {});
    if (windowCount > 0) void update($, tick, (n) => n + 1);
  });
  if (show.display === "rotate") {
    rotateTimer = $.clock.every(rotateMs, () => {
      if (windowCount >= 2) void update($, view, (n) => n + 1);
    });
  }
}

/**
 * Fills the footer again when the state was emptied under the module (a /clear), whatever order
 * the engine ran that in: the model is written at every start, so an empty one means it was lost.
 */
async function refill($: EngineInterface, show: Show, rotateMs: number) {
  if (lastModel === "" || (await read($, model)) !== "") return;
  await start($, show, rotateMs);
}

/** The element constructors the trees below are built from, as `$.ui.resolve(e)` hands them. */
type Ui = Pick<Elements["terminal"], "Box" | "Text">;

/** The left part's pieces for a step, each after a SEPARATOR but the first; empty when none shows. */
function leftTree({ Box, Text }: Ui, left: Left, step: Step) {
  const { name, level, folder, branch, percent, filled, value } = left;
  const hasBranch = step.hasBranch && branch !== "";
  const hasFolder =
    folder !== "" && (step.hasFolder || (step.hasBranch && branch === ""));
  const hasContext = step.hasContext && percent !== "";
  const segments = [
    step.hasModel && name ? <Text color="claude">{name}</Text> : null,
    step.hasEffort && level ? <Text dimColor>{level}</Text> : null,
    hasFolder || hasBranch ? (
      <Box flexDirection="row">
        {hasFolder ? <Text>{folder}</Text> : null}
        {hasBranch ? (
          <Text color="merged">{(hasFolder ? " " : "") + "git:("}</Text>
        ) : null}
        {hasBranch ? <Text color="suggestion">{branch}</Text> : null}
        {hasBranch ? <Text color="merged">)</Text> : null}
      </Box>
    ) : null,
    hasContext ? (
      <Box flexDirection="row">
        <Text dimColor>ctx </Text>
        {step.hasContextBar ? (
          <Text color={contextColor(value)}>{"━".repeat(filled)}</Text>
        ) : null}
        {step.hasContextBar ? (
          <Text dimColor>{"─".repeat(CELLS - filled) + " "}</Text>
        ) : null}
        <Text color={step.hasContextBar ? undefined : contextColor(value)}>
          {percent}
        </Text>
      </Box>
    ) : null,
  ].filter(Boolean);
  return segments.map((segment, i) => (
    <Box flexDirection="row" key={String(i)}>
      {i > 0 ? <Text dimColor>{SEPARATOR}</Text> : null}
      {segment}
    </Box>
  ));
}

/** The meter's windows for a step, BETWEEN apart; empty when none shows. */
function meterTree({ Box, Text }: Ui, meter: Meter[], step: Step) {
  return windowsFor(meter, step).map((w, i) => (
    <Box flexDirection="row" key={w.kind}>
      {i > 0 ? <Text dimColor>{BETWEEN}</Text> : null}
      <Text dimColor>{w.label}</Text>
      {step.hasMeterBar ? (
        <Text color={colorFor(w.percent)}>{" " + "━".repeat(w.filled)}</Text>
      ) : null}
      {step.hasMeterBar ? (
        <Text dimColor>{"─".repeat(CELLS - w.filled)}</Text>
      ) : null}
      <Text>{w.used}</Text>
      {step.hasReset && w.reset ? <Text dimColor>{w.reset}</Text> : null}
    </Box>
  ));
}

/** The whole row on a row of its own, `room` columns wide: the left part, the meter at the right end. */
function rowTree(ui: Ui, left: Left, meter: Meter[], room: number) {
  const step = fitRow(left, meter, room);
  const segments = leftTree(ui, left, step);
  const windows = meterTree(ui, meter, step);
  if (segments.length === 0 && windows.length === 0) return null;
  const { Box } = ui;
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      width={Number.isFinite(room) ? room : undefined}
    >
      <Box flexDirection="row">{segments}</Box>
      <Box flexDirection="row">{windows}</Box>
    </Box>
  );
}

export const register: Register = (on, options) => {
  seenAt = 0;
  windowCount = 0;
  lastHint = "";
  lastTidied = "";
  const hideCycleHint = options.hideCycleHint !== false;
  const hideInterruptHint = options.hideInterruptHint !== false;
  const rotateSeconds = Number(options.rotateSeconds);
  const rotateMs = (rotateSeconds > 0 ? rotateSeconds : ROTATE_SECONDS) * 1000;
  const display = DISPLAYS.includes(String(options.display))
    ? String(options.display)
    : "rotate";
  const position = POSITIONS.includes(String(options.position))
    ? String(options.position)
    : "footer";
  const showModelName = options.showModel !== false;
  const showEffort = options.showEffort !== false;
  const showContext = options.showContext !== false;
  const showUsage = options.showUsage !== false;
  const showGit = options.showGit !== false;
  const show: Show = {
    model: showModelName,
    effort: showEffort,
    git: showGit,
    context: showContext,
    usage: showUsage,
    display,
  };
  const hidden = [
    ...(hideCycleHint ? [CYCLE_HINT] : []),
    ...(hideInterruptHint ? [INTERRUPT_HINT] : []),
  ];

  /** The hint line without the parts hidden, and without the empty parts they leave. */
  function tidy(hint: string) {
    if (!hidden.some((part) => part.test(hint))) return hint;
    return hidden
      .reduce((line, part) => line.replace(part, " · "), hint)
      .split("·")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" · ");
  }

  on("session.start", async ($, e, next) => {
    isInteractive = e.isInteractive;
    await start($, show, rotateMs);
    return next(e);
  });

  // A /clear ends the session and goes on under a new one with no session.start and its state
  // emptied once this has run: the timers keep going and refill the footer (refill), a moment
  // after the clear and again on each tick and request, whatever this misses.
  on("session.end", ($, e, next) => {
    if (e.reason === "clear") {
      // shortcut: a fixed wait, as no event marks the new session (classic.SessionStart may be passed over by another plugin).
      $.clock.after(1000, () => void refill($, show, rotateMs).catch(() => {}));
      return next(e);
    }
    tickTimer?.cancel();
    tickTimer = undefined;
    rotateTimer?.cancel();
    rotateTimer = undefined;
    return next(e);
  });

  // Each request of the main loop names the model and effort it is really sent with.
  on("turn.step", async function* ($, e, next) {
    if (e.agentId === undefined) await refill($, show, rotateMs);
    if (e.agentId === undefined)
      await showModel(
        $,
        e.model,
        e.effort === undefined ? "" : String(e.effort),
      );
    return yield* next(e);
  });

  // /effort and /model write the settings and the session's model: shown as soon as they ran.
  on("command.run", { command: ["effort", "model"] }, async ($, e, next) => {
    const result = await next(e);
    await syncChoice($).catch(() => {});
    return result;
  });

  // A turn that committed, switched branch or moved the session shows at once.
  on("turn.complete", async ($, e, next) => {
    if (showGit && e.agentId === undefined) void syncGit($).catch(() => {});
    return next(e);
  });

  on("session.measure", async ($, e, next) => {
    await remember($, windowsOf(e.rateLimits));
    if (e.changed.includes("context")) await syncContext($, e.context);
    return next(e);
  });

  // Bottom right of the prompt footer: the meter, then what is beneath it (the engine's mode labels,
  // another plugin's switch), so a plugin that draws itself last stays last whichever wraps the other.
  // Where the row is short the meter is the last thing it gives up (fitRow).
  on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
    if (!showUsage || position !== "footer") return next(e);
    const [{ left, meter }, beneath] = await Promise.all([
      rowOf($, show),
      next(e),
    ]);
    if (meter.length === 0) return beneath;
    const hasBeneath = e.props.modes.length > 0 || !isBlank(beneath);
    if (e.surface === "terminal") {
      const width = hasBeneath ? widthOfNode(beneath, e.props.modes) : 0;
      if (width !== beneathWidth) {
        beneathWidth = width;
        $.ui.invalidate("ui.render");
      }
    }
    const step = fitRow(left, meter, roomOf(e), hintWidth, beneathWidth);
    const ui = $.ui.resolve(e);
    const windows = meterTree(ui, meter, step);
    if (windows.length === 0) return beneath;

    const { Box, Text } = ui;

    return (
      <Box flexDirection="row">
        {windows}
        {hasBeneath ? <Text dimColor>{SEPARATOR}</Text> : null}
        {beneath}
      </Box>
    );
  });

  // Left of the footer, right after the mode label the engine draws: the model, its effort, the folder
  // and git branch and the context fill, then the hint line ("(shift+tab to cycle)", "esc to interrupt"
  // while Claude works). The hint's width tells the meter how much room is left. With `position`
  // "below" the whole row goes on a row of its own under that line instead.
  on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
    if (e.props.hint !== lastHint) {
      lastHint = e.props.hint;
      lastTidied = tidy(e.props.hint);
    }
    const hint = lastTidied;
    const hasHint = hint.trim() !== "";
    const passHint = () =>
      hint === e.props.hint
        ? next(e)
        : next({ ...e, props: { ...e.props, hint } });
    if (position === "above") return passHint();
    const ui = $.ui.resolve(e);
    const { Box, Text } = ui;
    if (position === "below") {
      const [{ left, meter }, beneath] = await Promise.all([
        rowOf($, show),
        passHint(),
      ]);
      const row = rowTree(ui, left, meter, roomOf(e));
      if (row === null) return beneath;
      return (
        <Box flexDirection="column">
          {beneath}
          {row}
        </Box>
      );
    }
    if (e.surface === "terminal") {
      const width = hasHint ? widthOf(hint) : 0;
      if (width !== hintWidth) {
        hintWidth = width;
        $.ui.invalidate("ui.render");
      }
    }
    const [{ left, meter }, beneath] = await Promise.all([
      rowOf($, show),
      passHint(),
    ]);
    const step = fitRow(left, meter, roomOf(e), hintWidth, beneathWidth);
    const segments = leftTree(ui, left, step);
    if (segments.length === 0) return beneath;

    return (
      <Box flexDirection="row">
        {segments}
        {hasHint ? <Text dimColor>{SEPARATOR}</Text> : null}
        {hasHint ? beneath : null}
      </Box>
    );
  });

  // With `position` "above": the whole row in the band over the prompt, the meter at its right end.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (position !== "above" || e.props.hasSurvey) return next(e);
    const { left, meter } = await rowOf($, show);
    return rowTree($.ui.resolve(e), left, meter, e.props.bodyColumns) ?? next(e);
  });
};
