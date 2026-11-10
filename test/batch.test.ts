import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupSteps, loadRecipe, runBatch, substitute, validateSteps, type BatchDeps, type IndexedStep, type Step } from "../src/batch.ts";
import { UI_JXA } from "../src/scripts/ui.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "csmcp-batch-test-"));

function fakeDeps(over: Partial<BatchDeps> = {}): BatchDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runUi: async (steps: IndexedStep[]) => {
      calls.push(`ui:${steps.map((s) => s.i).join(",")}`);
      return { completed: steps.map((s) => ({ i: s.i, op: s.op, ok: true })) };
    },
    open: async (file) => void calls.push(`open:${file}`),
    isRunning: async () => false,
    isLocked: async () => false,
    sleep: async () => undefined,
    ...over,
  };
}

test("the JXA program still parses with the batch ops in it", () => {
  assert.doesNotThrow(() => new Function(UI_JXA));
  assert.match(UI_JXA, /batch: cmdBatch/);
});

test("substitute fills variables everywhere and rejects unknown ones", () => {
  const out = substitute({ a: "${x}/y", b: ["${n}"], c: 3 }, { x: "~/z", n: 124 });
  assert.deepEqual(out, { a: "~/z/y", b: ["124"], c: 3 });
  assert.throws(() => substitute("${nope}", { x: 1 }), /Unknown variable \$\{nope\}/);
});

test("validateSteps catches mistakes before the app is touched", () => {
  assert.doesNotThrow(() => validateSteps([{ op: "click", id: "0.1" }, { op: "moveFile", from: "/a", to: "/b" }]));
  assert.throws(() => validateSteps([{ op: "dance" }]), /unknown op/);
  assert.throws(() => validateSteps([{ op: "click" }]), /needs an id, text or role/);
  assert.throws(() => validateSteps([{ op: "assert", id: "0" }]), /needs "value"/);
  assert.throws(() => validateSteps([{ op: "clickMenu", path: ["File"] }]), /at least a menu and an item/);
  assert.throws(() => validateSteps([{ op: "click", id: "0", front: true }]), /isn't allowed/);
  assert.throws(() => validateSteps([{ op: "retry", steps: [{ op: "waitFile", path: "/a" }] }]), /can't run inside retry/);
});

test("groupSteps keeps UI runs together and breaks at Node steps", () => {
  const steps: Step[] = [
    { op: "requireUnlocked" },
    { op: "click", id: "0" },
    { op: "assert", id: "0", value: "1" },
    { op: "waitFile", path: "/a" },
    { op: "sleep", seconds: 1 },
  ];
  assert.deepEqual(
    groupSteps(steps).map((g) => (g.kind === "ui" ? g.steps.map((s) => s.i) : `node:${g.step.i}`)),
    ["node:1", [2, 3], "node:4", [5]],
  );
});

test("runBatch runs in order and leaves a finished status file", async () => {
  const dir = tmp();
  const statusFile = join(dir, "sub", "status.json");
  const deps = fakeDeps();
  const status = await runBatch({ name: "t", statusFile, steps: [{ op: "open", file: "/a.fcpxml" }, { op: "click", id: "0" }, { op: "click", id: "1" }] }, deps);
  assert.deepEqual(deps.calls, ["open:/a.fcpxml", "ui:2,3"]);
  assert.equal(status.state, "done");
  const saved = JSON.parse(readFileSync(statusFile, "utf8"));
  assert.equal(saved.state, "done");
  assert.equal(saved.results.length, 3);
  assert.equal(saved.current, undefined);
});

test("runBatch stops at a UI failure and keeps the steps that finished", async () => {
  const deps = fakeDeps({
    runUi: async (steps) => ({
      completed: [{ i: steps[0].i, op: steps[0].op, ok: true }],
      failed: { i: steps[1].i, op: steps[1].op, error: "gone", snapshot: { elements: [] } },
    }),
  });
  const status = await runBatch({ name: "t", steps: [{ op: "click", id: "0" }, { op: "click", id: "1" }, { op: "waitFile", path: "/never" }] }, deps);
  assert.equal(status.state, "failed");
  assert.equal(status.failed?.i, 2);
  assert.equal(status.results.length, 1);
});

test("a crash in a UI run is reported as a failure, not thrown", async () => {
  const deps = fakeDeps({ runUi: async () => { throw new Error("osascript died"); } });
  const status = await runBatch({ name: "t", steps: [{ op: "click", id: "0" }] }, deps);
  assert.equal(status.state, "failed");
  assert.match(status.failed!.error, /osascript died/);
});

test("requireUnlocked and requireClosed refuse to go on", async () => {
  const locked = await runBatch({ name: "t", steps: [{ op: "requireUnlocked" }] }, fakeDeps({ isLocked: async () => true }));
  assert.match(locked.failed!.error, /screen is locked/);
  const open = await runBatch({ name: "t", steps: [{ op: "requireClosed" }] }, fakeDeps({ isRunning: async () => true }));
  assert.match(open.failed!.error, /already running/);
});

test("an optional Node step that fails is skipped", async () => {
  const status = await runBatch({ name: "t", steps: [{ op: "moveFile", from: "/no/such/file", to: "/no/to", optional: true }, { op: "click", id: "0" }] }, fakeDeps());
  assert.equal(status.state, "done");
  assert.equal(status.results[0].ok, false);
  assert.match(String(status.results[0].skipped), /Nothing to move/);
});

test("moveFile moves, makes the folder, and never overwrites", async () => {
  const dir = tmp();
  const from = join(dir, "a.aif");
  const to = join(dir, "new", "b.aif");
  writeFileSync(from, "x");
  const first = await runBatch({ name: "t", steps: [{ op: "moveFile", from, to }] }, fakeDeps());
  assert.equal(first.state, "done");
  assert.ok(existsSync(to) && !existsSync(from));
  writeFileSync(from, "y");
  const second = await runBatch({ name: "t", steps: [{ op: "moveFile", from, to }] }, fakeDeps());
  assert.match(second.failed!.error, /Won't overwrite/);
  assert.equal(readFileSync(to, "utf8"), "x");
  assert.ok(existsSync(from));
});

test("waitFile returns once the file stops growing, and times out when it never appears", async () => {
  const dir = tmp();
  const path = join(dir, "bounce.aif");
  writeFileSync(path, "x");
  const real = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const ok = await runBatch({ name: "t", steps: [{ op: "waitFile", path, stableSeconds: 0.02, pollSeconds: 0.01 }] }, fakeDeps({ sleep: real }));
  assert.equal(ok.state, "done");
  assert.equal(ok.results[0].bytes, 1);
  const missing = await runBatch({ name: "t", steps: [{ op: "waitFile", path: join(dir, "no.aif"), timeoutSeconds: 0.03, pollSeconds: 0.01 }] }, fakeDeps({ sleep: real }));
  assert.match(missing.failed!.error, /Timed out/);
});

test("loadRecipe reads a recipe and refuses an empty one", () => {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify({ name: "r", app: "logic", vars: { tempo: 120 }, steps: [{ op: "hide" }] }));
  assert.deepEqual(loadRecipe(good), { name: "r", app: "logic", vars: { tempo: 120 }, steps: [{ op: "hide" }] });
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ steps: [] }));
  assert.throws(() => loadRecipe(bad), /no steps/);
});

test("requireAbsent stops on a leftover file and passes when the path is clear", async () => {
  const dir = tmp();
  const left = join(dir, "Output 1-2.aif");
  writeFileSync(left, "old bounce");
  const blocked = await runBatch({ name: "t", steps: [{ op: "requireAbsent", label: "no stale bounce", path: left }, { op: "click", id: "0" }] }, fakeDeps());
  assert.equal(blocked.state, "failed");
  assert.equal(blocked.failed!.label, "no stale bounce");
  assert.match(blocked.failed!.error, /already exists/);
  const clear = await runBatch({ name: "t", steps: [{ op: "requireAbsent", path: join(dir, "nothing.aif") }] }, fakeDeps());
  assert.equal(clear.state, "done");
  assert.throws(() => validateSteps([{ op: "requireAbsent" }]), /needs "path"/);
});

test("a done run lists the optional steps it passed over", async () => {
  const status = await runBatch({ name: "t", steps: [{ op: "moveFile", label: "optional move", from: "/no/such/file", to: "/no/to", optional: true }, { op: "click", id: "0" }] }, fakeDeps());
  assert.equal(status.state, "done");
  assert.equal(status.skipped?.length, 1);
  assert.match(status.skipped![0], /^1 optional move: Nothing to move/);
  const clean = await runBatch({ name: "t", steps: [{ op: "click", id: "0" }] }, fakeDeps());
  assert.equal(clean.skipped, undefined);
});
