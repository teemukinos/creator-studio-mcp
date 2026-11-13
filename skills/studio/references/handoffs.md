# Handoffs between tools

Use these formats when one tool's output feeds another.

**Craft handoffs add a sync step.** Craft apps see only the container's `/work/<job>/`, and local tools see only the job folder. Between a local tool and a Craft tool, sync first, in one call:

- Local → Craft: `craft_sync.py push <job folder>/<dir> <job>/<dir>`, then give the Craft command `/work/<job>/<dir>/…` paths.
- Craft → local: `craft_sync.py pull <job>/<dir> <job folder>/<dir>`, then check the files locally before the next tool reads them.
- Craft → Craft: no sync; pass `/work/<job>/…` paths. Pull only what the user reviews or what goes to `out/`.

The formats below hold for Craft too: PhotoCraft stands in for Pixelmator, FilmCraft for Final Cut, EffectCraft for Motion.

| From → To | Format |
|---|---|
| Pixelmator → Rive | SVG for shapes you'll animate, PNG with transparency for raster art. One layer per moving part. |
| Pixelmator → Blender | PNG/TIFF textures, power-of-two (1024, 2048) |
| Pixelmator → Godot | PNG sprites or sprite sheets with transparency; for pixel art, set the texture filter to Nearest in the import |
| Pixelmator → Final Cut / Motion | PNG with transparency, or layered PSD |
| Blender → Godot | `.glb` with textures embedded and animations baked. Use Godot name suffixes on objects: `-col`, `-convcol`, `-colonly`, `-navmesh`, `-rigid`, `-loop` (looping animation), `-noimp`. Prefer `.glb` over importing `.blend` directly, which needs Blender configured inside Godot. |
| Blender → Final Cut / Motion | PNG sequence with alpha (RGBA, film transparent) or ProRes 4444, matching the project frame rate |
| Blender → web / Unity / Rive scenes | `.glb`, textures embedded, animations baked |
| Blender → Pixelmator | Single PNG renders for compositing or touch-up |
| Logic → Final Cut / Motion | WAV at 48 kHz |
| Logic → Godot | OGG Vorbis for music and loops (set loop in the import), WAV for short SFX |
| Logic → Rive / web | M4A or MP3, short and trimmed |
| Motion → Final Cut | Published title/effect template, or ProRes 4444 with alpha |
| Rive → Final Cut | Rendered video from CLI frame renders, for promos only; the live product uses the `.riv` |
| Godot → Final Cut | PNG sequence or AVI from Movie Maker mode (`godot.md`), for trailers |
| Final Cut → anywhere | `scripts/render_fcpxml.py` on the timeline's FCPXML (headless; cuts, gaps and in/out points only), then `compressor_transcode` for other formats. File › Share needs Final Cut in front, so only the user can run it |
| PhotoCraft → VectorCraft / DesignCraft | PNG or TIFF placed by `/work/<job>/` path; PSD keeps layers |
| VectorCraft → DesignCraft | PDF or SVG, placed by path |
| EffectCraft → FilmCraft | ProRes 4444 or PNG sequence with alpha, matching the sequence frame rate (`file.import` / `media_import` by `/work/<job>/` path) |
| EffectCraft → web | Lottie JSON (`file.exportLottie`) |
| Craft → Final Cut / Compressor / Logic | Pull to the job folder first, then as the matching row above |
