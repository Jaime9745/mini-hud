/** One rate-limit window of the subscription, as the last API response reported it. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'mini-hud': { limits: Limit[]; view: number; tick: number; model: string; effort: string }
  }
}
