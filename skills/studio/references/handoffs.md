# Handoffs between tools

Use these formats when one tool's output feeds another.

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
| Final Cut → anywhere | File › Share, or Compressor (`compressor_transcode`) |
