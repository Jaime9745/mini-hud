# mini-hud

A minimal HUD for Claude Code, drawn in the prompt footer.

- **Left, right after the mode** (auto, plan, bypass…): the model, its reasoning effort, and the context fill as a bar and a percentage, like the usage meter, measured against the autocompact window (`autoCompactWindow`, or the model's own window), the way `/context` measures it.
- **Bottom right**: your subscription usage (5-hour and weekly windows) with a bar, a percentage and the time until it resets.

```
⏵⏵ bypass permissions on · Opus 5.5 · high · ctx ━━━━━───── 48%            5h ━━━━────── 42% ↻ 2h 3m
```

The context bar turns yellow from 50% and red from 75%. A `~` before the percentage means an estimate, before the first response reports tokens.

## Configure

Run `/mini-hud:configure`: it asks what to show and writes the options for you. The options:

| Option | Default | |
| --- | --- | --- |
| `showModel` | `true` | the model |
| `showEffort` | `true` | the effort level |
| `showContext` | `true` | context bar + % |
| `showUsage` | `true` | subscription usage at the right |
| `display` | `rotate` | see below |
| `rotateSeconds` | `8` | seconds per window when rotating |
| `hideCycleHint` | `true` | hide "(shift+tab to cycle)" |
| `hideInterruptHint` | `true` | hide "esc to interrupt" |

## Display modes

Set with the `display` option:

- `rotate` (default): one window at a time, switching every `rotateSeconds` (8 by default)
- `both`: the 5-hour and weekly windows side by side
- `session`: only the 5-hour window
- `week`: only the weekly window

When the row is narrow it drops the bar first, then the reset time, then the meter itself.

## Install

At the prompt of a terminal session:

```
/plugin install mini-hud --marketplace Jaime9745/mini-hud
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install mini-hud --marketplace Jaime9745/mini-hud
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `Jaime9745/mini-hud`, then Add plugin.

This repository is private: installing needs read access on GitHub and a git credential for github.com on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Credits

Based on [sub-meter](https://github.com/midudev/better-claude/tree/main/plugins/sub-meter) by midudev (MIT).
