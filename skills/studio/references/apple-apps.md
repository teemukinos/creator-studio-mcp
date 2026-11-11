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
- **Final Cut has no scripted export.** Export goes through File > Share or Send to Compressor, so it is a UI route: save it as a recipe once it works.
- **Keynote movie export** is fixed at 1080p height and written as H.264 `.m4v` (`iwork_export` format `mov`; a `.mov` path is renamed).
- **Compressor**: use `compressor_transcode`. For several outputs, submit them all before waiting, then wait once. Compressor ships different settings under one name (for example "H.264" and "HD 1080p"): the tool refuses such a name, so pass the `path` from `compressor_list_settings`.

## Multi-unit jobs (variants, image sets, decks)

Do direction once. Then one unit per session, running the same recipe or batch call with different vars, so N units cost one exploration plus N calls. Pixelmator image sets go in one `pixelmator_batch_process` call per output size: it applies one `resize` to every input. Check each output's size from the files (`pixelmator_image_info`), not from the call's result.

## Recipes

None verified yet. Worth saving first, as each route is proven:
- Final Cut: import FCPXML into a fresh library, Smart Conform to vertical, File > Share with a preset, wait for the file, move it to `out/`. Vars: fcpxml, library, preset, output.
- Motion: new project from the Project Browser (preset, frame rate, duration), import, File > Share > Export Movie.
- Keynote: Generate Slides from Text, save, export.

Record app version and date with each recipe.

## Dead ends

None recorded yet. Send each route that failed twice to the inbox (SKILL.md A8), with app version, date and the fallback used.
