# Final Cut Pro, Motion, Pixelmator Pro, Keynote, Pages, Numbers, Compressor

Read `ui.md` first for how to drive these through menus. Prefer the direct tools (SKILL.md B5) whenever they cover the task.

## AI features (verified on Creator Studio)

- **Final Cut Pro**: Edit > Generate Captions (Closed Captions / Subtitles); Clip > Enable Beat Detection and View > Beat Detection Grid; Modify > Smart Conform (auto-crop to vertical: set the project to vertical first), Add Magnetic Mask, Add Auto Mask, Enhance Light and Color, Balance Color, Match Color, Enhance Audio, Analyze and Fix; Trim > Detect Edits; Modify > Retime > Video Quality > Best (Machine Learning). Export: File > Export XML, File > Share > …, File > Send to Compressor.
- **Motion**: Object > Add Magnetic Mask; File > Import > Image Playground; File > Share > Export Movie; File > Send to Compressor. A new project starts from the Project Browser dialog (preset, frame rate, duration, then Open).
- **Pixelmator Pro**: Image > Super Resolution (also scriptable), plus the scriptable ML ops in `pixelmator_process_image`.
- **Keynote**: Slide > Generate Slides from Text, Generate Presenter Notes, Clean Up Slide; toolbar Generate Slides and Content Hub. Save (⌘S) before reading generated notes with `keynote_read_presentation`.
- **Numbers**: Magic Fill.

## Gotchas

- **Final Cut imports need `libraryLocation`**, or Final Cut silently imports nothing. A new `.fcpbundle` path creates the library. Media already in the target library can cause a duplicate-media error; a fresh library avoids it.
- **Final Cut has no scripted export, and Share can't run hidden** (Dead ends). To deliver a cut as a video file, render its FCPXML headless with `scripts/render_fcpxml.py` (Recipes).
- **Keynote movie export** is fixed at 1080p height and written as H.264 `.m4v` (`iwork_export` format `mov`; a `.mov` path is renamed).
- **Compressor**: use `compressor_transcode`. For several outputs, submit them all before waiting, then wait once. Compressor ships different settings under one name (for example "H.264" and "HD 1080p"): the tool refuses such a name, so pass the `path` from `compressor_list_settings`.

## Multi-unit jobs (variants, image sets, decks)

Do direction once. Then one unit per session, running the same recipe or batch call with different vars, so N units cost one exploration plus N calls. Pixelmator image sets go in one `pixelmator_batch_process` call per output size: it applies one `resize` to every input. Check each output's size from the files (`pixelmator_image_info`), not from the call's result.

## Recipes

- **Rough cut to MP4 without Final Cut** (verified 2026-11-11, ffmpeg 8): build the timeline with `finalcut_build_timeline` and an `output` path, then in a Mac shell run `python3 <skill folder>/scripts/render_fcpxml.py <timeline.fcpxml> <job>/out/<name>.mp4`. Add `--codec hevc` for HEVC (hardware encoder) and `--overwrite` to replace a file. It prints PASS only when size, frame rate, duration and audio match the timeline. It renders asset-clips and gaps in spine order: each clip cut to its in point and length, fitted into the frame with black bars, at the sequence frame rate, with 48 kHz stereo audio (silence for clips without audio). Stills work. Markers, effects, titles and connected clips are not rendered; it refuses a spine with anything else. Push the same FCPXML to Final Cut (`pushToFinalCut`) when the user also wants to edit it there. In Claude chat there is no Mac shell: give the user the command.

Worth saving next, as each route is proven:
- Motion: new project from the Project Browser (preset, frame rate, duration), import, File > Share > Export Movie.
- Keynote: Generate Slides from Text, save, export.

Record app version and date with each recipe.

## Dead ends

Send each route that failed twice to the inbox (SKILL.md A8), with app version, date and the fallback used.

- **Selecting a project in hidden Final Cut, for File > Share** (Final Cut Pro Creator Studio, 2026-11-11): Share needs a project selected in the browser, and an imported project isn't opened or selected. The browser's items have no Accessibility elements, and hidden Final Cut ignores sidebar selection set through Accessibility and arrow keys sent in the background. While hidden, its menus also report a stale enabled state (a closed library's Close Library item stayed listed). A real click works only with Final Cut in front, which the no-editor rule forbids. Export XML and Send to Compressor need the same selection. Fallback: `scripts/render_fcpxml.py` (Recipes); a user who wants Final Cut's own export shares by hand.
