import { expect, mock, test } from "claude-code/testing";

import {
  cellsFor,
  cut,
  fitRow,
  folderOf,
  prettyModel,
  windowsFor,
} from "./register";

test("model ids read as names", () => {
  expect(prettyModel("claude-opus-5-5")).toBe("Opus 5.5");
  expect(prettyModel("claude-sonnet-4-5-20250929[1m]")).toBe("Sonnet 4.5 1M");
  expect(prettyModel("claude-haiku-4")).toBe("Haiku 4");
  expect(prettyModel("opus")).toBe("Opus");
  expect(prettyModel("gpt-x.y")).toBe("gpt-x.y");
});

test("the context bar fills ten cells", () => {
  expect(cellsFor(0)).toBe(0);
  expect(cellsFor(48)).toBe(5);
  expect(cellsFor(100)).toBe(10);
  expect(cellsFor(140)).toBe(10);
  expect(cellsFor(-3)).toBe(0);
});

test("the folder is the last segment of the path", () => {
  expect(folderOf("C:\\Users\\jaime\\mini-hud")).toBe("mini-hud");
  expect(folderOf("/home/me/work/app/")).toBe("app");
});

test("long names are cut with an ellipsis", () => {
  expect(cut("main", 20)).toBe("main");
  expect(cut("feature/very-long-branch-name", 10)).toBe("feature/v…");
});

test("the row gives up pieces in order, the usage meter last", () => {
  const left = {
    name: "Opus 5.5",
    level: "medium",
    folder: "mini-hud",
    branch: "main*",
    percent: "~13%",
    filled: 1,
    value: 13,
  };
  const meter = [
    {
      kind: "five_hour",
      label: "5h",
      percent: 42,
      filled: 4,
      used: " 42%",
      reset: " ↻ 1h 3m",
    },
  ];
  // Left: model 8, effort 9, 'mini-hud git:(main*)' 23, folder gone 14, ctx with bar 22, % only 11.
  // Meter: with bar 25, without 14, without reset 6. Two columns between the two sides.
  const off = (room: number) =>
    Object.entries(fitRow(left, meter, room))
      .filter(([key, on]) => !on && key !== "hasBothWindows")
      .map(([key]) => key); // one window: nothing to give up there
  expect(off(62 + 2 + 25)).toEqual([]);
  expect(off(62 + 2 + 25 - 1)).toEqual(["hasContextBar"]);
  expect(off(51 + 2 + 14)).toEqual(["hasContextBar", "hasMeterBar"]);
  expect(off(42 + 2 + 14)).toEqual([
    "hasContextBar",
    "hasMeterBar",
    "hasFolder",
  ]);
  expect(off(42 + 2 + 6)).toEqual([
    "hasContextBar",
    "hasMeterBar",
    "hasFolder",
    "hasReset",
  ]);
  expect(off(28 + 2 + 6)).toContain("hasBranch");
  expect(off(19 + 2 + 6)).toContain("hasEffort");
  expect(off(8 + 2 + 6)).toContain("hasContext");
  expect(off(8)).toContain("hasModel");
  expect(off(8)).not.toContain("hasMeter");
  expect(off(7)).toContain("hasMeter");
});

test("the hint and what is beneath the meter take room too", () => {
  const left = {
    name: "Opus 5.5",
    level: "",
    folder: "",
    branch: "",
    percent: "",
    filled: 0,
    value: 0,
  };
  const meter = [
    {
      kind: "five_hour",
      label: "5h",
      percent: 42,
      filled: 4,
      used: " 42%",
      reset: "",
    },
  ];
  // 'Opus 5.5 · ? for help' 21, gap 2, '5h 42%' 6, ' · focus' 8
  expect(fitRow(left, meter, 37, 10, 5).hasModel).toBe(true);
  expect(fitRow(left, meter, 36, 10, 5).hasModel).toBe(false);
});

test("with both windows shown, the one nearest its limit stays alone", () => {
  const meter = [
    {
      kind: "five_hour",
      label: "5h",
      percent: 42,
      filled: 4,
      used: " 42%",
      reset: "",
    },
    {
      kind: "seven_day",
      label: "week",
      percent: 71,
      filled: 7,
      used: " 71%",
      reset: "",
    },
  ];
  const left = {
    name: "",
    level: "",
    folder: "",
    branch: "",
    percent: "",
    filled: 0,
    value: 0,
  };
  expect(windowsFor(meter, fitRow(left, meter, Infinity)).length).toBe(2);
  const one = fitRow(left, meter, 2 + "week 71%".length);
  expect(windowsFor(meter, one).map((w) => w.kind)).toEqual(["seven_day"]);
});

test("a /clear fills the footer again once the engine empties the state", async ($, on) => {
  const clock = mock.clock(on);
  mock.store(on);
  // The engine emptying the state: reads find nothing until the plugin writes again.
  let isWiped = false;
  on("state.get", async (_, e, next) => {
    const read = await next(e);
    if (!isWiped || read.value === undefined) return read;
    return { value: { value: undefined, version: read.value.version } };
  });
  on("state.set", (_, e, next) => {
    isWiped = false;
    return next(e);
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("session.model", () => ({ value: "claude-opus-5-5" }));
  on("session.cwd", () => ({ value: "/work/app" }));
  on("session.usage", () => ({
    value: { startedAt: 0, rateLimits: [], context: { window: 200000 } },
  }));
  on("settings.read", () => ({ value: {} }));
  on("process.run", () => ({
    value: {
      exitCode: 128,
      stdout: "",
      stderr: "",
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }));
  on("ui.render", { component: "PromptHint" }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>{e.props.hint}</Text>;
  });

  await $.session.start({
    cwd: "/work/app",
    surface: "terminal",
    isInteractive: true,
  });
  await $.session.end({
    reason: "clear",
    sessionId: "a",
    resume: { id: "a" },
  } as never);
  isWiped = true;
  await clock.advance(1000); // before the first tick: the refill after the clear
  const ui = await $.ui.mount({
    plugin: "mini-hud",
    surface: "terminal",
    component: "PromptHint",
    props: { isDraft: false, isWorking: false, hint: "? for shortcuts" },
  });
  expect((await ui.find({ type: "Text", text: /Opus/ }))?.text).toBe(
    "Opus 5.5",
  );
  await ui.unmount();
  await $.session.end({
    reason: "other",
    sessionId: "b",
    resume: { id: "b" },
  } as never);
});

test("an /effort shows at once, before the next request", async ($, on) => {
  mock.clock(on);
  mock.store(on);
  let effort = "medium";
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.model", () => ({ value: "claude-opus-5-5" }));
  on("session.cwd", () => ({ value: "/work/app" }));
  on("session.usage", () => ({
    value: { startedAt: 0, rateLimits: [], context: { window: 200000 } },
  }));
  on("settings.read", () => ({
    value: { modelSettings: { "claude-opus-5-5": { effortLevel: effort } } },
  }));
  on("process.run", () => ({
    value: { exitCode: 128, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
  }));
  on("command.run", () => {
    effort = "high"; // the command writes the settings
    return { text: "" };
  });
  on("ui.render", { component: "PromptHint" }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>{e.props.hint}</Text>;
  });

  await $.session.start({ cwd: "/work/app", surface: "terminal", isInteractive: false });
  await $.command.run({ command: "effort", args: "high" } as never);
  const ui = await $.ui.mount({
    plugin: "mini-hud",
    surface: "terminal",
    component: "PromptHint",
    props: { isDraft: false, isWorking: false, hint: "? for shortcuts" },
  });
  expect((await ui.find({ type: "Text", text: /^(medium|high)$/ }))?.text).toBe("high");
  await ui.unmount();
});

for (const position of ["footer", "above"] as const) {
  test(`position ${position} draws the row where it says`, { options: { position } }, async ($, on) => {
    mock.clock(on);
    mock.store(on, { limits: [{ kind: "five_hour", percentUsed: 41 }], at: 1 });
    on("session.start", (_, e) => ({ cwd: e.cwd }));
    on("session.model", () => ({ value: "claude-opus-5-5" }));
    on("session.cwd", () => ({ value: "/work/app" }));
    on("session.usage", () => ({
      value: { startedAt: 0, rateLimits: [], context: { window: 200000 } },
    }));
    on("settings.read", () => ({ value: {} }));
    on("process.run", () => ({
      value: { exitCode: 128, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
    }));
    on("ui.render", ($, e) => {
      const { Text } = $.ui.resolve(e);
      return <Text>engine</Text>;
    });
    await $.session.start({ cwd: "/work/app", surface: "terminal", isInteractive: false });

    const viewport = { columns: 160, rows: 40 };
    const texts = async (component: "PromptHint" | "SessionMode" | "AbovePrompt", props: object) => {
      const ui = await $.ui.mount({ plugin: "mini-hud", surface: "terminal", component, viewport, props } as never);
      const all = (await ui.findAll({ type: "Text" })).map((t) => t.text).join("");
      await ui.unmount();
      return all;
    };
    const hint = await texts("PromptHint", { isDraft: false, isWorking: false, hint: "? for shortcuts" });
    const mode = await texts("SessionMode", { modes: [] });
    const above = await texts("AbovePrompt", {
      hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 150, scroll: { offset: 0, bodyRows: 10 }, view: {},
    });
    const drawn = { footer: hint + mode, above }[position];
    expect(drawn).toContain("Opus 5.5");
    expect(drawn).toContain("5h");
    if (position !== "above") expect(above).toBe("engine");
    if (position === "above") expect(hint + mode).not.toContain("Opus 5.5");
  });
}
