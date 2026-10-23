/** One rate-limit window of the subscription, as the last API response reported it. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** How full the context is against the autocompact window; an estimate until a response reports tokens. */
export type Fill = { value: number; isEstimate: boolean } | null

/** The session's folder, its git branch (empty outside a repository) and whether it has uncommitted changes. */
export type Git = { folder: string; branch: string; isDirty: boolean } | null

declare module 'claude-code' {
  interface PluginState {
    'mini-hud': { limits: Limit[]; view: number; tick: number; model: string; effort: string; context: Fill; git: Git }
  }
}
