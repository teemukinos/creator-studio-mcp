/**
 * ui_batch: run a known sequence of UI steps with one tool call.
 *
 * Every tool call costs the assistant a full round trip, so a sequence that is already known
 * shouldn't be driven one click at a time. Runs of UI steps share one osascript process, so the
 * app is hidden once at the end of the run rather than after each step, which would close pop-ups.
 * File steps and app launches run here in Node, between those runs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { absPath } from "./paths.js";
const TARGET_OPS = new Set(["click", "setValue", "stepValue", "waitFor", "assert"]);
export const UI_OPS = new Set(["clickMenu", "click", "setValue", "stepValue", "waitFor", "assert", "keys", "snapshot", "sleep", "hide", "retry"]);
export const NODE_OPS = new Set(["open", "waitFile", "moveFile", "requireUnlocked", "requireClosed", "requireAbsent"]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Replace ${name} in every string of a step list. An unknown name is an error, never left in place. */
export function substitute(value, vars) {
    if (typeof value === "string") {
        return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name) => {
            if (!(name in vars))
                throw new Error(`Unknown variable \${${name}}. Passed: ${Object.keys(vars).join(", ") || "none"}`);
            return String(vars[name]);
        });
    }
    if (Array.isArray(value))
        return value.map((v) => substitute(v, vars));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
    }
    return value;
}
export function validateSteps(steps, uiOnly = false) {
    steps.forEach((s, n) => {
        const at = `Step ${n + 1}${s.label ? ` (${s.label})` : ""}`;
        const need = (...keys) => {
            for (const k of keys)
                if (s[k] === undefined)
                    throw new Error(`${at}: ${s.op} needs "${k}"`);
        };
        if (!UI_OPS.has(s.op) && !NODE_OPS.has(s.op)) {
            throw new Error(`${at}: unknown op "${s.op}". Ops: ${[...UI_OPS, ...NODE_OPS].join(", ")}`);
        }
        if (uiOnly && !UI_OPS.has(s.op))
            throw new Error(`${at}: ${s.op} can't run inside retry`);
        // Batches always stay off screen. There is deliberately no way to bring the app forward.
        if (s.front !== undefined)
            throw new Error(`${at}: "front" isn't allowed in a batch`);
        if (TARGET_OPS.has(s.op) && s.id === undefined && s.text === undefined && s.role === undefined) {
            throw new Error(`${at}: ${s.op} needs an id, text or role`);
        }
        if (s.op === "setValue" || s.op === "assert")
            need("value");
        if (s.op === "stepValue")
            need("to");
        if (s.op === "keys")
            need("key");
        if (s.op === "sleep")
            need("seconds");
        if (s.op === "waitFile" || s.op === "requireAbsent")
            need("path");
        if (s.op === "moveFile")
            need("from", "to");
        if (s.op === "clickMenu" && !(Array.isArray(s.path) && s.path.length >= 2)) {
            throw new Error(`${at}: clickMenu needs a path of at least a menu and an item`);
        }
        if (s.op === "retry") {
            need("steps");
            validateSteps(s.steps, true);
            if (s.onFail !== undefined)
                validateSteps(s.onFail, true);
        }
    });
}
/** Number the steps from 1 and put each unbroken run of UI steps into one group. */
export function groupSteps(steps) {
    const groups = [];
    steps.forEach((s, n) => {
        const step = { ...s, i: n + 1 };
        const last = groups[groups.length - 1];
        if (NODE_OPS.has(s.op))
            groups.push({ kind: "node", step });
        else if (last?.kind === "ui")
            last.steps.push(step);
        else
            groups.push({ kind: "ui", steps: [step] });
    });
    return groups;
}
export function loadRecipe(path) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw.steps) || raw.steps.length === 0)
        throw new Error(`Recipe has no steps: ${path}`);
    return { name: raw.name ?? "recipe", app: raw.app, vars: raw.vars ?? {}, steps: raw.steps };
}
/** Write the status so a reader never sees half a file. */
function writeStatus(file, status) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(status, null, 2));
    renameSync(tmp, file);
}
async function waitFile(step, sleep) {
    const path = absPath(String(step.path));
    const timeoutMs = Number(step.timeoutSeconds ?? 900) * 1000;
    const stableMs = Number(step.stableSeconds ?? 5) * 1000;
    const pollMs = Number(step.pollSeconds ?? 1) * 1000;
    const start = Date.now();
    let size = -1;
    let since = start;
    while (Date.now() - start < timeoutMs) {
        if (existsSync(path)) {
            const now = statSync(path).size;
            if (now !== size) {
                size = now;
                since = Date.now();
            }
            else if (Date.now() - since >= stableMs) {
                return { path, bytes: size, waited: Math.round((Date.now() - start) / 1000) };
            }
        }
        await sleep(pollMs);
    }
    throw new Error(`Timed out after ${step.timeoutSeconds ?? 900} s waiting for ${path} to appear and stop growing`);
}
function moveFile(step) {
    const from = absPath(String(step.from));
    const to = absPath(String(step.to));
    if (!existsSync(from))
        throw new Error(`Nothing to move at ${from}`);
    if (existsSync(to))
        throw new Error(`Won't overwrite ${to}`);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return { moved: to };
}
async function runNode(step, deps) {
    const sleep = deps.sleep ?? wait;
    const until = async (test) => {
        const end = Date.now() + Number(step.waitSeconds ?? 0) * 1000;
        let hit = await test();
        while (!hit && Date.now() < end) {
            await sleep(1000);
            hit = await test();
        }
        return hit;
    };
    switch (step.op) {
        case "open":
            await deps.open(step.file === undefined ? undefined : absPath(String(step.file)));
            return { opened: step.file ?? true };
        case "requireUnlocked":
            if (!(await until(async () => !(await deps.isLocked())))) {
                throw new Error("The screen is locked, so the app's windows can't be reached. Unlock the Mac and run this again.");
            }
            return {};
        case "requireClosed":
            if (!(await until(async () => !(await deps.isRunning())))) {
                throw new Error("The app is already running. This recipe needs a fresh launch, and quitting could lose open work, so quit it first.");
            }
            return {};
        case "requireAbsent": {
            const path = absPath(String(step.path));
            if (existsSync(path)) {
                throw new Error(`${path} already exists. Left over from an earlier run, it would be taken for this run's output or block a later move. Move it away or delete it, then run again.`);
            }
            return {};
        }
        case "waitFile":
            return waitFile(step, sleep);
        case "moveFile":
            return moveFile(step);
        default:
            throw new Error(`Not a Node step: ${step.op}`);
    }
}
/** Run the steps in order and stop at the first failure. The status file is current after every group. */
export async function runBatch(input, deps) {
    const started = Date.now();
    const status = {
        name: input.name,
        state: "running",
        startedAt: new Date(started).toISOString(),
        seconds: 0,
        total: input.steps.length,
        results: [],
    };
    const save = () => {
        status.seconds = Math.round((Date.now() - started) / 1000);
        if (input.statusFile)
            writeStatus(input.statusFile, status);
    };
    const finish = (failed) => {
        status.state = failed ? "failed" : "done";
        status.failed = failed;
        const skipped = status.results.filter((r) => r.skipped !== undefined).map((r) => `${r.i} ${r.label ?? r.op}: ${r.skipped}`);
        if (skipped.length)
            status.skipped = skipped;
        status.finishedAt = new Date().toISOString();
        delete status.current;
        save();
        return status;
    };
    save();
    for (const group of groupSteps(input.steps)) {
        if (group.kind === "ui") {
            const first = group.steps[0];
            const last = group.steps[group.steps.length - 1];
            status.current = `steps ${first.i} to ${last.i}`;
            save();
            let out;
            try {
                out = await deps.runUi(group.steps);
            }
            catch (e) {
                return finish({ i: first.i, op: first.op, label: first.label, error: e.message });
            }
            status.results.push(...out.completed);
            if (out.failed)
                return finish(out.failed);
        }
        else {
            const { step } = group;
            status.current = `step ${step.i}: ${step.label ?? step.op}`;
            save();
            try {
                const detail = await runNode(step, deps);
                status.results.push({ i: step.i, op: step.op, label: step.label, ok: true, ...detail });
            }
            catch (e) {
                const error = e.message;
                if (!step.optional)
                    return finish({ i: step.i, op: step.op, label: step.label, error });
                status.results.push({ i: step.i, op: step.op, label: step.label, ok: false, skipped: error });
            }
        }
        save();
    }
    return finish();
}
