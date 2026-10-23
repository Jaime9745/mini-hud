---
name: configure
description: Configure mini-hud — choose what the footer shows (model, effort, context, subscription usage), how the usage meter displays (rotate, both, 5h only, week only), rotation seconds, and which hints to hide. Use when the user runs /mini-hud:configure or asks to change mini-hud's display.
---

# Configure mini-hud

mini-hud reads its options from `~/.claude/settings.json` under `pluginConfigs.<key>.options`, where `<key>` is:

- `mini-hud@mini-hud` when installed from the `Jaime9745/mini-hud` marketplace (check `enabledPlugins` for a key starting with `mini-hud@`),
- `mini-hud` when loaded from a folder (`--plugin-dir`, a dev mods folder).

If both could apply, write the options under both keys.

## Steps

1. Read `~/.claude/settings.json` and show the current values (defaults when unset: every `show*` and `hide*` is `true`, `display` is `rotate`, `rotateSeconds` is `8`).
2. Ask with AskUserQuestion, in the user's language, in one call:
   - **What to show** (multiSelect): Model (`showModel`), Effort (`showEffort`), Context with moon and % (`showContext`), Subscription usage 5h / week (`showUsage`). Pre-describe the current state in each option's description.
   - **Usage display** (only matters if usage is shown): `rotate` (alternate 5h and week), `both`, `session` (5h only), `week` (week only).
   - **Hints to hide** (multiSelect): "(shift+tab to cycle)" (`hideCycleHint`), "esc to interrupt" (`hideInterruptHint`).
3. If they chose `rotate`, ask how many seconds per window (offer 5, 8, 15; "Other" allows any number ≥ 1) → `rotateSeconds`.
4. Back up the file to `~/.claude/settings.json.bak-mini-hud`, then merge the answers into `pluginConfigs.<key>.options`, keeping every other key in the file as is. Booleans are JSON `true`/`false`; an unselected item in a multiSelect is `false`.
5. Tell the user in one or two lines what changed. The mod reloads with the new options by itself; if it doesn't, they can restart the session.

Never touch other settings keys.
