# Logic Pro, driven hidden

Verified with Logic Pro 12.4 on 2026-11-06. Element ids can change with a Logic update: on a new version, run recipes with `dryRun: true` first to check the steps and vars (it doesn't touch Logic), then expect to re-read ids with `ui_snapshot` when a step fails.

## Recipes

- **Build, bounce, master, save** (any job that imports finished audio layers): `recipes/logic_render.recipe.json` in this skill's folder, via `ui_batch` (creator-studio 0.7.1 or later). Pass the recipe's absolute path. One call per version. When a step fails, read the status file's `failed` entry first.
  - Vars: `fcpxml` (the layers as FCPXML), `tempo` (BPM), `key` (as Logic shows it, for example `G Minor`), `workDir` (the job folder that receives the bounces), `logicDir` (the folder the project saves into), `projectName`, `saveFolderName` (the name of `logicDir` as the save panel shows it).
  - Before: clear old `logic_bounce_*.aif` and `<projectName>.logicx` in the job. The recipe's `requireAbsent` steps stop the run at the start if these, `~/Music/Logic/Bounces/Output 1-2.aif` or `<logicDir>/Project.logicx` exist, so a stale file can't pass as the new bounce.
  - After: read the status's `skipped` list (the key steps are optional), then run the null test and the master checks (`remix.md`). The recipe checks format (AIFF, 48 kHz, 24-bit, no dither, Normalize off) on both bounces, but it can't judge audio.
  - The bounce lands as `Output 1-2.aif` only while the project is untitled. The recipe bounces before it saves, so this holds; a saved or reopened project bounces to `<project>.aif`.

## Rules

- Screen unlocked, one project per launch, metronome off, Normalize off after every launch. The recipe enforces these.
- Logic fixes the project end at import (at 120 BPM) and doesn't move it when the tempo rises. Pad layers to (bars + 0.5) × 2 s and trim after.
- Never touch the user's own Logic projects, such as `~/Music/Logic/Project.logicx`.
- Don't use `ui_set_value` where the value might not stick, and never on a save panel field: if it doesn't stick, it types into whatever app is frontmost.

## Dead ends with Logic hidden

Don't retry these without a new reason.

- **MIDI import**: the panel hangs. Render MIDI parts to audio in code.
- **Plug-ins on single tracks, Stem Splitter, Session Players, Chord Track**: not reachable. Use code: Demucs for stems, code DSP for effects.
- **A second project in one launch** shows no windows. Quit and relaunch.
- **Roland TR-909 patch**: needs Sound Library content that isn't installed; downloading needs the user's OK.
- **Not yet tested**: Chord ID, Sound Library browsing. Budget 5 requests, then stop and log the result in the inbox (SKILL.md A8).
