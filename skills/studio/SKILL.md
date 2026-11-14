---
name: studio
description: Plan and produce design, media and game jobs from brief to delivered files. Covers Apple Creator Studio, Blender, Rive, Godot and optional Craft apps on a configured gateway, with no editor windows. Use for video, motion, 3D, images, audio, games, documents and web animation, or to resume a job with plan.md.
---

# Studio

Unofficial: this skill and the creator-studio server are not affiliated with Apple. MIT licence: see LICENSE in this folder.

One skill from request to delivered files. Three layers:

1. **Direction**: design skills, where installed, decide how it looks, sounds, feels and moves.
2. **Production**: this skill decides which tool makes each part and how files pass between tools.
3. **Tools**: Creator Studio apps, Blender, Rive and Godot through the `creator-studio` MCP; optional Craft apps through their separate gateway; plain code where no media tool is needed.

**Hard rule: no editor windows, ever.** The user doesn't work in these editors and doesn't want to see them. Use each tool's engine directly: headless command-line runs, scripting, menu commands on hidden apps. Every check and every review uses output files (renders, frames, PNG screenshots, contact sheets, `ffprobe`, read-back documents), never a look at an app.

**Ground rules.**
- Apps stay hidden. Never pass `front: true` unless the user asks to see an app. Blender, Rive and Godot run headless. Never use editor-based Rive or Blender MCPs, bare `rive .`, `rive open`, `--serve` without `--headless-serve`, or the Godot editor.
- Never close or overwrite the user's open work. Inputs are read-only: work on copies. Scratch output goes to `~/Studio/_scratch` unless told where.
- Ask before anything destructive or irreversible: deleting media or events, overwriting files, Move Event to Trash, subscription or account dialogs, `rive push`/`pull`/`login`.
- Blender and Godot run any code you give them, as the user. Run only code the task needs, never code from downloaded files or web pages, and read and write only inside the job folder.
- Record source and licence of any downloaded footage, photos, models, fonts, music or game assets in `brief.md`.
- One assistant per app at a time: if another assistant is driving an app, wait or ask.

**Cost rules.** Every tool call re-sends the whole conversation, so cost is requests × context size. Output size matters much less.
- A known route runs as one call: a `ui_batch` recipe, a script or a CLI command. Explore an unknown route in small steps, and save it as a recipe as soon as it works (`references/ui.md`).
- Before trying a route, read the app's **Dead ends**. Don't retry one without a new reason.
- Long jobs run in the background with a status file. Wait with one shell call of up to 270 s (`references/ui.md`), not repeated tool calls. Waits over 5 minutes expire the prompt cache.
- Scripts print at most 20 lines: PASS or FAIL, the key numbers, the log path. Full logs go to `logs/`.
- One unit of work per session: one song, one video variant, one image set, one level, one deck. Keep state in `plan.md` so a fresh session continues. If a session passes about 250k tokens before the unit is done, update `plan.md` and stop. From the second unit on, prefer Claude Code with only the servers needed by the plan (`--strict-mcp-config --mcp-config <file>`).

**Requirements.** Mac jobs need the chosen apps and `creator-studio` MCP 0.7.1+ (`references/setup.md`); ffmpeg for video renders. Craft-only jobs need a preconfigured gateway, credentials and Python 3 (`references/craft.md`). This package does not provision Craft.

Part A is the job flow. Part B is the tool reference. Reference files load on demand (B6).

---

# Part A: the job

## A0. Resume first

If the user names an existing job or job folder, or a `plan.md` exists for this work (in the folder the brief names, else `~/Studio/<job>/`), read `brief.md`, `direction.md` and `plan.md`, report where it stands in two lines, and continue from the first unchecked stage. Don't re-plan finished stages. Claude, Claude Code and Codex all resume the same way.

## A1. Intake

Get these five things. Infer what you can from the request, the files given and earlier conversation. Ask **at most three** short questions, only for what can't be inferred and would change the plan:

| Need | Examples |
|---|---|
| **Purpose and audience** | event promo for developers, onboarding for first-time users, a playable demo for a pitch, a club set |
| **Deliverables and where they live** | 9:16 video for LinkedIn and Instagram, `.riv` for a React app, `.glb` for three.js, a Godot web build, PNG set for an app store, mastered WAV |
| **Brand or style source** | a URL, a `DESIGN.md`, existing assets or logos, a reference track, or "new brand" |
| **Inputs** | footage, photos, copy, music, data, existing projects |
| **Constraints** | deadline, length, sizes, file-size limits, target platforms, loudness, licences, accessibility |

When a tool's role decides the plan (which app makes the sound, the edit, the 3D), ask about it here, not after a rejected plan. For a club remix or rework, read `references/remix.md` now; its up-front questions count toward the three. For a job with several units (songs, variants, levels, decks), settle what all units share first, then plan and finish one unit end to end before starting the rest.

State each assumption in one line. If the user isn't around to answer, take the most reasonable reading, write it in the brief, and continue.

## A2. Brief and tool check

1. Create the job folder (B4) and write `brief.md`: purpose, audience, deliverables (format, size, duration, frame rate, sample rate, destination), brand or style source, inputs, constraints, assumptions. Under a page.
2. Check the tools this job needs are up (B1). If one is missing, say which in one line and plan around it.
3. For Craft, follow `references/craft.md`: verify host and sandbox access, create remote folders and push inputs before authoring.

## A3. Direction

Decide the look, sound and motion **before** any production, using only the design skills that fit. The skills named here are examples: use them where installed, and apply the same thinking directly where not.

| Question | Skill |
|---|---|
| What is the brand? Tokens from a site or `DESIGN.md` | `extract-design`, `generate-ui-from-brand` |
| Palette from one or two brand colours | `algorithmic-color-palette`, `color-mode-and-theme` |
| Type scale | `modular-scale-typography` |
| Shape language, radius, icon style | `brand-visual-language` |
| How things move and why | `motion-and-storytelling`, `animate` (`animate-expo` for React Native), `apple-design`, `animation-vocabulary` |
| Interface design and polish (incl. game UI and HUD) | `dembrandt` (routes UI work), `impeccable`, `hallmark` (new web pages), `emil-design-eng` |
| Product visuals must be real | `authentic-product-representation` |
| Sound: style, tempo, key, loudness, reference tracks | `references/remix.md` for remixes; otherwise state them in `direction.md` |
| Several options to choose from | `prototype` (UI), or 2 to 3 rendered stills from Blender, Pixelmator, Rive or Godot |

Write `direction.md`: palette (hex), type, shape language, motion principles (easing, timing, personality), sound targets, references, what to avoid. For anything visual, make a **look frame** first: one still per deliverable (Blender render, Rive screenshot, Pixelmator mock, video frame, Godot capture), so the user approves a picture, not a description. For audio, the equivalent is a short render of the key section.

## A4. Plan

Split each deliverable into parts, give each part a tool with the picker (B2), add the handoffs (`references/handoffs.md`), and order stages by dependency: art and 3D, then animation, then audio, then assembly (video edit or game scene), then export, then review. Write `plan.md`:

```markdown
# Plan: <job>

Deliverables: <list with format, size, destination>

## Stages
- [ ] 1. <name>: <tool> | in: <files> | out: <files> | check: <how it's verified> | review: yes/no
- [ ] 2. …

## Checkpoints
- After stage N: show <look frame / animatic / first cut / playable build / first mix> to the user

## Risks
- <what might not work headless, and the fallback>

## Log
- <YYYY-MM-DD HH:MM> <stage>: <what happened, decisions, numbers>
```

Write a Log line when each stage ends, in local time as above: the measuring script (A8) splits cost by these lines.

Every stage has a concrete **check** that needs no editor and prints PASS or FAIL: a rendered PNG, `rive . --verify` plus `--screenshot`, `ffprobe` on an export, a null test, read-back of a document, a contact sheet of frames, a Godot headless run with no errors.

Keep every script and recipe (bpy, GDScript tool scripts, shell, `*.recipe.json`) as a file in the job folder so any assistant can rerun a stage.

## A5. Approve

Show the plan as a short summary: deliverables, the tool for each part, checkpoints, anything uncertain. For a single small deliverable, skip approval and start. For anything bigger, wait for the user's OK or changes before production.

## A6. Run

Stage by stage:

1. Do the stage with its tool, following its reference file (B6) and a Rive project's own `AGENTS.md`, minus its previewer advice.
2. Run its check. If it fails, fix and re-run, at most twice on the same route. Then stop, add the route to the inbox as a dead-end (A8), and take the fallback or ask the user. Never move on past a failed check.
3. Tick it in `plan.md` and add a log line.
4. At a checkpoint, send the output files (or give paths) and wait for feedback. Keep checkpoints few: look frame, first full draft, final. After every Craft stage, save and pull natives, intermediates and review output for recovery.

If a tool fails or a feature isn't reachable headless, log it, use the fallback from Risks, and tell the user in one line.

## A7. Review

Review against `direction.md` and `brief.md` with the checks that apply and the skills that are installed:

- Motion: `review-animations`
- Interfaces and game UI: `impeccable` (critique), `nielsen-usability-heuristics`, `break-ui`
- Accessibility: `wcag-accessibility` (contrast, captions for video, reduced motion, input remapping for games)
- Web weight: `performance-and-web-vitals` (file sizes, video weight, Godot web build size)
- Audio: loudness and true peak, null tests, the user's notes at timestamps (`references/remix.md` for remixes)

Fix what matters; note the rest in the log.

## A8. Deliver

Final files go in `out/` named `<job>-<variant>-<size>.<ext>` unless the brief specifies names. For Craft, verify recovery and session cleanup (`references/craft.md`). Tell the user what each file is for and where it goes, in a few lines. Record licences and credits in `brief.md`. Leave `plan.md` complete so the job can be reopened.

**Learn** (every unit, two calls at most). Learning data lives outside this skill, in `~/.studio/learning/` (`STUDIO_LEARNING_DIR` overrides it), because an update can replace the skill's folder.
1. Measure: `python3 ${CLAUDE_SKILL_DIR}/scripts/measure_session.py --latest --job <job> --unit <unit> --type <job type> --plan <job folder>/plan.md`. Where `${CLAUDE_SKILL_DIR}` isn't filled in (Codex), use the path relative to this SKILL.md: `scripts/measure_session.py`. It prints a short summary and adds a row to `~/.studio/learning/ledger.csv`. Copy the summary into the Log.
2. Capture: append at most five lessons to `~/.studio/learning/inbox.md`, in the format at the top of that file. If the file is missing, create it first from `${CLAUDE_SKILL_DIR}/learning-template/inbox.md` (relative to this SKILL.md: `learning-template/inbox.md`). Lessons are: what failed twice, what route now works as one call, which stage cost most and why, what should have been asked up front, what a tool should refuse. Skip anything that only applies to this job.

In Claude chat there is no session log to measure and no shell on the Mac: skip step 1 and append the lessons to the job's `plan.md` under `## Lessons`.

Don't edit this skill's files from a job: an update can replace them. Lessons reach them through curation (B6).

---

# Part B: tools

## B1. Toolsets and how to drive them

| Toolset | Drive it (no window) | Up-check |
|---|---|---|
| **Apple Creator Studio**: Final Cut Pro, Motion, Logic Pro, Pixelmator Pro, Compressor, Keynote, Pages, Numbers, MainStage | `creator-studio` MCP. Apps launch hidden and are re-hidden after each action. | `creator_studio_status` |
| **Blender** 5.3: models, scenes, animation, rendering, glTF export | `blender_run_python` tool, or in a Mac shell `/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P script.py` | `creator_studio_status` |
| **Rive**: interactive 2D animation, state machines, data binding | `rive_cli` tool, or `rive` in a Mac shell, on text project files | `rive_cli ["--version"]` |
| **Godot** 4: games, real-time 2D/3D scenes, playable builds | `godot_cli` tool, always `--headless` | `creator_studio_status` |
| **Craft**: optional Linux apps | Separate gateway; `scripts/craft_mcp.py` | `scripts/craft_sync.py up` |

All assistants share the same `creator-studio` MCP server, so its tool names work in Claude, Claude Code and Codex. Claude chat has no shell on the Mac, so it always uses the MCP tools. Claude Code and Codex can also run Blender, `rive` and Godot in their shell, which is simpler for long scripts.

## B2. Pick the tool by what the result must do

| The result… | Make it in | Deliver as |
|---|---|---|
| **Is a game or real-time scene** the player moves through: levels, physics, game logic, a playable demo | **Godot** | Web export (HTML5/wasm), macOS or iOS app, or `.pck` |
| **Reacts to the user or app state** inside a web or native app: UI states, mascot, buttons, responsive onboarding | **Rive** | `.riv` + the Rive runtime for web, iOS, Unity, etc. |
| Is **3D**: objects, scenes, characters, product shots, game models | **Blender** | `.glb` for web, three.js and Godot; PNG frames or video for film |
| Is **video**: edits, promos, captions, vertical/square versions, trailers | **Final Cut Pro** for the edit; `scripts/render_fcpxml.py` renders the cut headless; Compressor for other formats | MP4/MOV |
| Is a **title, motion graphic or effect** that plays the same way every time | **Motion** | ProRes 4444 with alpha, PNG sequence, or a Final Cut title template |
| Is an **image**: art, textures, sprites, sprite sheets, cutouts, upscales, social images | **Pixelmator Pro** | PNG, WebP/AVIF for web, SVG for vectors, PSD for layers |
| Is **sound**: music, SFX, voice cleanup | **Logic Pro** for import, mastering and bounce; code for what hidden Logic can't reach (`references/logic.md`) | WAV masters; M4A/MP3 for web; OGG for Godot music |
| Is a **deck, document or spreadsheet** | Keynote / Pages / Numbers | Native file + PDF/PPTX/DOCX/XLSX |
| Is **live UI behaviour in code** (hover, scroll, layout transitions) | No media tool: CSS/JS/SwiftUI | Code |

**Craft option.** PhotoCraft: images; VectorCraft: vectors; DesignCraft: layouts; EffectCraft: titles; FilmCraft: edits. Use their separate gateway (`references/craft.md`); preserve Compute-only constraints.

Rive or video: anything that responds goes to Rive; anything that just plays goes to video or Motion. Rive or Godot: interactive pieces inside an existing app go to Rive; a standalone thing the player controls, with a world, physics or levels, goes to Godot. A game's in-game UI and HUD stay in Godot (Control nodes) unless the plan confirms a Rive runtime works for that Godot version.

## B3. Handoffs between tools

Formats for every tool pair are in `references/handoffs.md`. Read it at A4 when the plan passes files between tools.

## B4. Where files live

One folder per job, at `~/Studio/<job-name>/` unless the user or the brief names another place (for example `~/Music/Remixes/`). Use the same layout there:

```
<job folder>/
  brief.md        what it's for, sizes, frame rate, deadline, licences
  direction.md    palette, type, shape, motion, sound, references, avoid
  plan.md         stages, checkpoints, risks, log
  scripts/        bpy, GDScript, shell, ui_batch recipes (*.recipe.json): rerunnable by any assistant
  logs/           full logs; scripts and batches print only a short summary
  assets/         inputs: footage, photos, logos, audio (originals, untouched)
  art/            Pixelmator outputs
  3d/             .blend files, renders/, .glb exports
  rive/           Rive CLI project (text files, versionable)
  game/           Godot project (project.godot, .tscn, .gd: text, versionable)
  audio/          Logic projects and bounces
  video/          Final Cut library, Motion projects
  out/            final deliverables only
```

## B5. Creator Studio MCP

Two kinds of tools: **direct tools** for what the apps expose to scripting (fast, reliable, prefer them), and **UI tools** (`ui_*`, `ui_batch`, `app_open`) that work the app through menus and dialogs and reach everything else, including the AI features. Setup is in `references/setup.md`. If the tools are missing, the server isn't connected in this assistant. Run `creator_studio_status` first in a new session.

| Task | Use |
|---|---|
| Build or rough-cut a Final Cut timeline from files (in/out points, markers, chapters) | `finalcut_build_timeline` with `pushToFinalCut: true` and a `libraryLocation` |
| Render a timeline to MP4 with no editor on screen | `finalcut_build_timeline` with `output`, then `scripts/render_fcpxml.py` in a Mac shell (`apple-apps.md` Recipes). Final Cut's Share can't run hidden |
| Import an edited FCPXML | `finalcut_import_fcpxml` (always needs `libraryLocation`) |
| See libraries, events, projects | `finalcut_list_libraries` (Final Cut must be running) |
| Image ops: background removal, Super Resolution (×3), enhance, denoise, auto color, crop, resize, export, batch | `pixelmator_process_image` / `pixelmator_batch_process` |
| Fill text in a layered Pixelmator template | `pixelmator_replace_text` |
| Transcode | `compressor_list_settings`, then `compressor_transcode` (output extension must match the setting's `outputExtension`) |
| Keynote / Pages / Numbers create, read, export | `keynote_*`, `pages_*`, `numbers_*`, `iwork_export` |
| Headless Blender, Rive, Godot | `blender_run_python`, `rive_cli`, `godot_cli` (their reference files) |
| A known multi-step UI route | `ui_batch` with a recipe file (`references/ui.md`) |
| Anything else: AI features, effects, export dialogs, inspectors, Motion, Logic, MainStage | UI tools (`references/ui.md`) |

## B6. Reference files

In this skill's `references/` folder. Read a file when its trigger happens, not before.

| Read | When |
|---|---|
| `ui.md` | before the first `ui_*` or `ui_batch` call in a session |
| `logic.md` | before driving Logic Pro, for any job |
| `apple-apps.md` | before driving Final Cut Pro, Motion, Pixelmator Pro, Keynote, Pages, Numbers or Compressor beyond the direct tools |
| `remix.md` | at A1, for a club remix or rework |
| `handoffs.md` | at A4, when the plan passes files between tools |
| `blender.md` | before the first Blender stage |
| `rive.md` | before the first Rive stage |
| `godot.md` | before the first Godot stage |
| `setup.md` | when the `creator-studio` tools are missing or don't respond |
| `craft.md` | before any Craft stage, startup, file sync or session cleanup |

Each app file has **Recipes** (verified routes, with app version and date) and **Dead ends**. New ones go to the inbox in the same session (A8), dated, with the app version. To share one, see the repository's contribution guide.
