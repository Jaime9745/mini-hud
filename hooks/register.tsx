// Based on sub-meter by midudev (MIT): https://github.com/midudev/better-claude
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, RenderViewport, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Fill, Git, Limit } from '../types'

const limits = atom({ plugin: 'mini-hud', key: 'limits' } as const, [] as Limit[])
const view = atom({ plugin: 'mini-hud', key: 'view' } as const, 0) // which window the rotating meter shows
const tick = atom({ plugin: 'mini-hud', key: 'tick' } as const, 0) // redraws the countdown
const model = atom({ plugin: 'mini-hud', key: 'model' } as const, '')
const effort = atom({ plugin: 'mini-hud', key: 'effort' } as const, '')
const git = atom({ plugin: 'mini-hud', key: 'git' } as const, null as Git)
const context = atom({ plugin: 'mini-hud', key: 'context' } as const, null as Fill)

const contextColor = (percent: number) => (percent >= 75 ? 'error' : percent >= 50 ? 'warning' : 'claude')
/** The last segment of a path, either separator. */
export const folderOf = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() ?? path

let lastGit = ''
let isReadingGit = false

/**
 * The session's folder and, in a git repository, its branch (a worktree's own) and whether it has
 * uncommitted changes, as claude-hud shows them by default. Read on a timer, not per drawing.
 */
async function syncGit ($: EngineInterface) {
  if (isReadingGit) return
  isReadingGit = true
  try {
    const cwd = await $.session.cwd()
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 1000 })
    const branch = head.exitCode === 0 ? head.stdout.trim() : ''
    const status = branch ? await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain'], { cwd, timeoutMs: 1000 }) : undefined
    const next: Git = { folder: folderOf(cwd), branch, isDirty: status !== undefined && status.exitCode === 0 && status.stdout.trim() !== '' }
    const key = JSON.stringify(next)
    if (key === lastGit) return
    lastGit = key
    await update($, git, () => next)
  } finally {
    isReadingGit = false
  }
}

/** Cells of a 10-cell bar a fill takes, 0 to 10. */
export const cellsFor = (percent: number) => Math.round((Math.min(Math.max(percent, 0), 100) / 100) * 10)

// The compaction window (autoCompactWindow, or the model's own) and the model it was read for.
let compactTokens = 0
let compactFor = ''
let lastFill: Fill = null
let isCounting = false

/**
 * The fill against the window autocompact measures, as /context does: the engine's own `percent` is
 * against the model's whole window. The window is read once per model (a local estimate, no request),
 * and the fill is that estimate until a response reports tokens.
 */
async function syncContext ($: EngineInterface, usage: SessionContextUsage) {
  if (isCounting) return
  let estimate: number | undefined
  if (compactFor !== lastSessionModel || usage.tokens === undefined) {
    isCounting = true
    try {
      const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
      if (breakdown) {
        compactTokens = breakdown.rawMaxTokens
        compactFor = lastSessionModel
        estimate = breakdown.percentage
      }
    } finally {
      isCounting = false
    }
  }
  const max = compactTokens || usage.window
  const value = usage.tokens !== undefined && max > 0 ? (usage.tokens / max) * 100 : estimate
  const fill: Fill = value === undefined ? null : { value, isEstimate: usage.tokens === undefined }
  if (lastFill?.value === fill?.value && lastFill?.isEstimate === fill?.isEstimate) return
  lastFill = fill
  await update($, context, () => fill)
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-5-20250929[1m]" → "Sonnet 4.5 1M", "opus" → "Opus". */
export function prettyModel (id: string) {
  const m = /^(?:claude-)?([a-z]+)(?:-(\d+))?(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id)
  if (!m) return id
  const [, word = '', major, minor, big] = m
  return word.charAt(0).toUpperCase() + word.slice(1) + (major ? ` ${major}` : '') + (minor ? `.${minor}` : '') + (big ? ' 1M' : '')
}

let lastModel = ''
let lastEffort = ''
let lastSessionModel = ''

/** Writes model and effort only when they change, so each request does not redraw the footer. */
async function showModel ($: EngineInterface, id: string, level: string) {
  const name = prettyModel(id)
  if (name !== lastModel) { lastModel = name; await update($, model, () => name) }
  if (level !== lastEffort) { lastEffort = level; await update($, effort, () => level) }
}

const WINDOWS = ['five_hour', 'seven_day']
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'week' }
const ROTATE_SECONDS = 8
const TICK_MS = 8000
const DISPLAYS = ['rotate', 'both', 'session', 'week']
const WINDOW_OF: Record<string, string> = { session: 'five_hour', week: 'seven_day' }
const CELLS = 10
const CYCLE_HINT = /\s*\([^()]+ to cycle\)/
const INTERRUPT_HINT = /\s*esc to interrupt/
// The terminal footer's row: two columns of padding at each end, the mode label at the left
// (`⏵⏵ accept edits on ·`, the longest but bypass's) and the hint after it, two columns at least
// between that and what is drawn here.
const FOOTER_PADDING = 4
const FOOTER_GAP = 2
const MODE_LABEL = 20
const SEPARATOR = ' · '
const BETWEEN = '  |  '
// Room left, when nothing of another plugin is beneath, for one that may wrap the meter and draw
// after it: Narrator's narrowest switch (`⏵`) and its separator.
const AROUND = 1 + SEPARATOR.length
// The least another plugin's drawing beneath counts for when the meter weighs its bar and reset time
// (Narrator's `⏵ narrator`): what that plugin gives up where the row is short is not taken back for
// them, so the meter only shrinks as the row does.
const BENEATH_FLOOR = 10

// The hint as last drawn on the terminal, in columns.
let hintWidth = 0
let lastHint = ''
let lastTidied = ''
let windowCount = 0
let tickTimer: { cancel: () => void } | undefined
let rotateTimer: { cancel: () => void } | undefined

/** The subscription windows the meter shows, in order, from what the engine measured. */
const windowsOf = (rateLimits: readonly SessionRateLimit[]): Limit[] =>
  WINDOWS.flatMap(kind => {
    const found = rateLimits.find(limit => limit.kind === kind)
    return found ? [{ kind, percentUsed: found.percentUsed, resetsAt: found.resetsAt }] : []
  })

/** Whether a drawing beneath shows nothing: no text, no control (the engine's own node draws `modes`, counted apart). */
function isBlank (node: RenderNode | undefined): boolean {
  if (node === undefined || node === null) return true
  if (typeof node === 'string') return node.trim() === ''
  if (node.type === 'engine') return true
  return (node.type === 'Box' || node.type === 'Text') && (node.children ?? []).every(isBlank)
}

/** Columns a text takes: one per character, none for a variation selector. */
const widthOf = (text: string) => [...text.replace(/[\uFE0E\uFE0F]/g, '')].length

/** Columns a drawing beneath takes on one row; the engine's own node draws `modes`, joined by ` & `. */
function widthOfNode (node: RenderNode | undefined, modes: readonly string[]): number {
  if (node === undefined || node === null) return 0
  if (typeof node === 'string') return widthOf(node)
  if (node.type === 'engine') return widthOf(modes.join(' & '))
  return (node.children ?? []).reduce((sum, child) => sum + widthOfNode(child, modes), 0)
}

/** Whether a drawing beneath holds another plugin's: the engine stamps each hook's root with its plugin. */
function holdsPlugin (node: RenderNode | undefined): boolean {
  if (node === undefined || node === null || typeof node === 'string' || node.type === 'engine') return false
  return 'part' in node || (node.children ?? []).some(holdsPlugin)
}

/** Columns the footer leaves at its right end on the terminal, beside the mode label and the hint; elsewhere, no limit. */
function roomOf (e: { surface: string; viewport?: RenderViewport }) {
  if (e.surface !== 'terminal' || e.viewport === undefined) return Infinity
  return e.viewport.columns - FOOTER_PADDING - FOOTER_GAP - MODE_LABEL - (hintWidth > 0 ? 1 + hintWidth : 0)
}

const colorFor = (percent: number) => (percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'claude')

/** "42m", "3h 5m", "2d 4h": how long until the window resets. */
function until (ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

// When the reading this session shows was taken; the shared store carries the newest one of any session.
let seenAt = 0

/** Keeps the latest reading for the meter, and for the next session until a response reports again. */
async function remember ($: EngineInterface, found: Limit[]) {
  if (found.length === 0) return
  seenAt = await $.clock.now()
  windowCount = found.length
  await update($, limits, () => found)
  await $.store.set('limits', found)
  await $.store.set('at', seenAt) // after the limits, so a reader that sees the new time finds the new limits
}

/** Adopts the reading another session left in the shared store, when it is newer than ours. */
async function syncFromStore ($: EngineInterface) {
  const at = Number(await $.store.get('at')) || 0
  if (at <= seenAt) return
  const saved = await $.store.get('limits')
  if (!Array.isArray(saved)) return
  seenAt = at
  windowCount = saved.length
  await update($, limits, () => saved as Limit[])
}

/** The windows to draw: all of them, the one the rotation is on, or the one chosen. With fewer than two readings, whatever there is. */
function visible (all: Limit[], display: string, index: number): Limit[] {
  if (display === 'both' || all.length < 2) return all
  if (display === 'rotate') return all.slice(index % all.length).slice(0, 1)
  return all.filter(limit => limit.kind === WINDOW_OF[display])
}

export const register: Register = (on, options) => {
  seenAt = 0
  windowCount = 0
  lastHint = ''
  lastTidied = ''
  const hideCycleHint = options.hideCycleHint !== false
  const hideInterruptHint = options.hideInterruptHint !== false
  const rotateSeconds = Number(options.rotateSeconds)
  const rotateMs = (rotateSeconds > 0 ? rotateSeconds : ROTATE_SECONDS) * 1000
  const display = DISPLAYS.includes(String(options.display)) ? String(options.display) : 'rotate'
  const showModelName = options.showModel !== false
  const showEffort = options.showEffort !== false
  const showContext = options.showContext !== false
  const showUsage = options.showUsage !== false
  const showGit = options.showGit !== false
  const hidden = [...(hideCycleHint ? [CYCLE_HINT] : []), ...(hideInterruptHint ? [INTERRUPT_HINT] : [])]

  /** The hint line without the parts hidden, and without the empty parts they leave. */
  function tidy (hint: string) {
    if (!hidden.some(part => part.test(hint))) return hint
    return hidden
      .reduce((line, part) => line.replace(part, ' · '), hint)
      .split('·')
      .map(part => part.trim())
      .filter(Boolean)
      .join(' · ')
  }

  on('session.start', async ($, e, next) => {
    tickTimer?.cancel()
    tickTimer = undefined
    rotateTimer?.cancel()
    rotateTimer = undefined
    const [saved, storedAt, usage] = await Promise.all([
      $.store.get('limits'),
      $.store.get('at'),
      $.session.usage()
    ])
    if (Array.isArray(saved)) {
      windowCount = saved.length
      await update($, limits, () => saved as Limit[])
    }
    seenAt = Number(storedAt) || 0

    await remember($, windowsOf(usage.rateLimits))

    // Before the first request: the session's model, and the effort the settings give it.
    // shortcut: an effort set with /effort shows from the next request on, as turn.step carries it.
    lastModel = lastEffort = ''
    lastSessionModel = await $.session.model()
    const [perModel, level] = await Promise.all([
      $.settings.read({ key: 'modelSettings' }),
      $.settings.read({ key: 'effortLevel' })
    ])
    const own = (perModel as Record<string, { effortLevel?: unknown }> | undefined)?.[lastSessionModel]?.effortLevel
    await showModel($, lastSessionModel, String(own ?? level ?? ''))
    compactFor = ''
    lastFill = null
    isCounting = false
    await syncContext($, usage.context)
    lastGit = ''
    isReadingGit = false
    if (showGit) void syncGit($).catch(() => {}) // git is not waited on: the session starts at once

    if (e.isInteractive) {
      // Another session's reading shows up within TICK_MS of being stored.
      tickTimer = $.clock.every(TICK_MS, () => {
        void syncFromStore($).catch(() => {}) // a failed read keeps the reading on screen
        // A /model switch shows before the next request does.
        void $.session.model().then(id => {
          if (id === lastSessionModel) return
          lastSessionModel = id
          return showModel($, id, lastEffort)
        }).catch(() => {})
        // A resume, a rewind, a compaction or a /model switch moves the fill without a measurement.
        void $.session.usage().then(usage => syncContext($, usage.context)).catch(() => {})
        if (showGit) void syncGit($).catch(() => {})
        if (windowCount > 0) void update($, tick, n => n + 1)
      })
      if (display === 'rotate') {
        rotateTimer = $.clock.every(rotateMs, () => {
          if (windowCount >= 2) void update($, view, n => n + 1)
        })
      }
    }
    return next(e)
  })

  on('session.end', ($, e, next) => {
    tickTimer?.cancel()
    tickTimer = undefined
    rotateTimer?.cancel()
    rotateTimer = undefined
    return next(e)
  })

  // Each request of the main loop names the model and effort it is really sent with.
  on('turn.step', async function * ($, e, next) {
    if (e.agentId === undefined) await showModel($, e.model, e.effort === undefined ? '' : String(e.effort))
    return yield * next(e)
  })

  // A turn that committed, switched branch or moved the session shows at once.
  on('turn.complete', async ($, e, next) => {
    if (showGit && e.agentId === undefined) void syncGit($).catch(() => {})
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await remember($, windowsOf(e.rateLimits))
    if (e.changed.includes('context')) await syncContext($, e.context)
    return next(e)
  })


  // Bottom right of the prompt footer: the meter, then what is beneath it (the engine's mode labels,
  // another plugin's switch), so a plugin that draws itself last stays last whichever wraps the other.
  // Where the row is short the meter gives up its bar, then the time until the reset, then itself.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!showUsage) return next(e)
    const all = await read($, limits)
    if (all.length === 0) return next(e)
    const index = display === 'rotate' && all.length >= 2 ? await read($, view) : 0
    const shown = visible(all, display, index)
    if (shown.length === 0) return next(e)
    // Subscribes this drawing to the countdown tick alongside reading the clock and beneath node
    const [, now, beneath] = await Promise.all([read($, tick), $.clock.now(), next(e)])
    const hasBeneath = e.props.modes.length > 0 || !isBlank(beneath)

    const windows = shown.map(limit => {
      const resetsIn = limit.resetsAt === undefined ? undefined : Date.parse(limit.resetsAt) - now
      const hasReset = resetsIn !== undefined && resetsIn <= 0
      const percent = hasReset ? 0 : limit.percentUsed
      const filled = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * CELLS)
      const label = LABELS[limit.kind] ?? limit.kind
      const used = ` ${Math.round(percent)}%`
      const reset = resetsIn !== undefined && !hasReset ? ` ↻ ${until(resetsIn)}` : ''
      return { kind: limit.kind, label, percent, filled, used, reset, short: widthOf(label + used) }
    })
    const below = widthOfNode(beneath, e.props.modes)
    const hasPlugin = holdsPlugin(beneath)
    const room = roomOf(e) - (hasBeneath ? below + SEPARATOR.length : 0) - (hasPlugin ? 0 : AROUND)
    const given = hasPlugin ? Math.max(0, BENEATH_FLOOR - below) : 0
    const short = windows.reduce((sum, w) => sum + w.short, (windows.length - 1) * BETWEEN.length)
    const bars = windows.length * (1 + CELLS)
    const resets = windows.reduce((sum, w) => sum + widthOf(w.reset), 0)
    const fit = [
      { hasBar: true, hasReset: true, width: short + bars + resets },
      { hasBar: false, hasReset: true, width: short + resets },
      { hasBar: false, hasReset: false, width: short }
    ].find(({ hasReset, width }) => width <= (hasReset ? room - given : room))
    if (!fit) return beneath

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row">
        {windows.map((w, i) => (
          <Box flexDirection="row" key={w.kind}>
            {i > 0 ? <Text dimColor>{BETWEEN}</Text> : null}
            <Text dimColor>{w.label}</Text>
            {fit.hasBar ? <Text color={colorFor(w.percent)}>{' ' + '━'.repeat(w.filled)}</Text> : null}
            {fit.hasBar ? <Text dimColor>{'─'.repeat(CELLS - w.filled)}</Text> : null}
            <Text>{w.used}</Text>
            {fit.hasReset && w.reset ? <Text dimColor>{w.reset}</Text> : null}
          </Box>
        ))}
        {hasBeneath ? <Text dimColor>{SEPARATOR}</Text> : null}
        {beneath}
      </Box>
    )
  })

  // Left of the footer, right after the mode label the engine draws: the model, its effort and the
  // context fill, then the hint line ("(shift+tab to cycle)", "esc to interrupt" while Claude works).
  // Its width tells the meter at the right how much room is left.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.props.hint !== lastHint) {
      lastHint = e.props.hint
      lastTidied = tidy(e.props.hint)
    }
    const hint = lastTidied
    const [shownName, shownLevel, shownFill, shownGit] = await Promise.all([read($, model), read($, effort), read($, context), read($, git)])
    const repo = showGit ? shownGit : null
    const branch = repo?.branch ? repo.branch + (repo.isDirty ? '*' : '') : ''
    const where = repo === null ? '' : repo.folder + (branch ? ` git:(${branch})` : '')
    const name = showModelName ? shownName : ''
    const level = showEffort ? shownLevel : ''
    const fill = showContext ? shownFill : null
    const percent = fill === null ? '' : `${fill.isEstimate ? '~' : ''}${Math.round(fill.value)}%`
    const filled = fill === null ? 0 : cellsFor(fill.value)
    const bar = fill === null ? '' : `ctx ${'━'.repeat(filled)}${'─'.repeat(CELLS - filled)} ${percent}`
    const parts = [name, level, where, bar].filter(Boolean)
    const hasHint = hint.trim() !== ''
    if (e.surface === 'terminal') {
      const ours = parts.length === 0 ? 0 : widthOf(parts.join(SEPARATOR))
      const width = widthOf(hint) + ours + (ours > 0 && hasHint ? SEPARATOR.length : 0)
      if (width !== hintWidth) {
        hintWidth = width
        $.ui.invalidate('ui.render')
      }
    }
    const beneath = await (hint === e.props.hint ? next(e) : next({ ...e, props: { ...e.props, hint } }))
    if (parts.length === 0) return beneath

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row">
        {name ? <Text color="claude">{name}</Text> : null}
        {level ? <Text dimColor>{(name ? SEPARATOR : '') + level}</Text> : null}
        {where && (name || level) ? <Text dimColor>{SEPARATOR}</Text> : null}
        {where && repo ? <Text>{repo.folder}</Text> : null}
        {branch ? <Text color="merged">{' git:('}</Text> : null}
        {branch ? <Text color="suggestion">{branch}</Text> : null}
        {branch ? <Text color="merged">)</Text> : null}
        {fill !== null && (name || level || where) ? <Text dimColor>{SEPARATOR}</Text> : null}
        {fill !== null ? <Text dimColor>ctx </Text> : null}
        {fill !== null ? <Text color={contextColor(fill.value)}>{'━'.repeat(filled)}</Text> : null}
        {fill !== null ? <Text dimColor>{'─'.repeat(CELLS - filled)}</Text> : null}
        {fill !== null ? <Text>{' ' + percent}</Text> : null}
        {hasHint ? <Text dimColor>{SEPARATOR}</Text> : null}
        {hasHint ? beneath : null}
      </Box>
    )
  })
}
