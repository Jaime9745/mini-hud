# mini-hud

A minimal HUD for Claude Code, drawn at the bottom right of the prompt footer: the model you are using, its reasoning effort, and your subscription usage (5-hour and weekly windows) with a bar, a percentage and the time until it resets.

```
Opus 5.5 · high  |  5h ━━━━────── 42% ↻ 2h 3m
```

## Display modes

Set with the `display` option:

- `rotate` (default): one window at a time, switching every `rotateSeconds` (8 by default)
- `both`: the 5-hour and weekly windows side by side
- `session`: only the 5-hour window
- `week`: only the weekly window

When the row is narrow it drops the bar first, then the reset time, then the usage; the model and effort stay longest.

It also hides "(shift+tab to cycle)" and "esc to interrupt" to make room (`hideCycleHint`, `hideInterruptHint`).

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
