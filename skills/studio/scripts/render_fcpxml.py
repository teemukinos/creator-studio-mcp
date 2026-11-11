#!/usr/bin/env python3
"""Render a rough-cut FCPXML to a video file with ffmpeg, without opening Final Cut Pro.

  render_fcpxml.py <timeline.fcpxml> <out.mp4|out.mov> [--codec h264|hevc] [--overwrite]

h264 uses libx264 (CRF 18); hevc uses the Mac's hardware encoder (VideoToolbox).

Reads the first project's sequence: its format (size, frame rate) and the spine's asset-clip and gap
elements, as finalcut_build_timeline writes them. Each clip is cut to its in point and duration,
fitted into the frame with black bars, converted to the sequence frame rate, and joined in order.
Audio is 48 kHz stereo AAC; a clip without audio gets silence. Markers, effects, titles,
connected clips and compound clips are not rendered: a spine with anything else is refused.

Needs ffmpeg and ffprobe on PATH (brew install ffmpeg). Never overwrites a file unless --overwrite.
Prints 5 lines: PASS or FAIL, then size, frame rate, duration and the output path.
Exit code 0 on PASS, 1 on FAIL, 2 on bad input.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from fractions import Fraction
from urllib.parse import unquote, urlparse

STILLS = {".png", ".jpg", ".jpeg", ".heic", ".tif", ".tiff", ".bmp", ".gif", ".webp"}


def fail(msg, code=2):
    print(f"FAIL {msg}")
    sys.exit(code)


def rtime(s):
    """FCPXML rational time ("1001/30000s", "4s") as a Fraction of seconds."""
    m = re.fullmatch(r"(\d+)(?:/(\d+))?s", (s or "0s").strip())
    if not m:
        fail(f"bad time value: {s!r}")
    return Fraction(int(m.group(1)), int(m.group(2) or 1))


def src_path(url):
    p = urlparse(url)
    if p.scheme not in ("file", ""):
        fail(f"media is not a local file: {url}")
    return unquote(p.path)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("fcpxml")
    ap.add_argument("output")
    ap.add_argument("--codec", choices=["h264", "hevc"], default="h264")
    ap.add_argument("--overwrite", action="store_true")
    a = ap.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            fail(f"{tool} not found on PATH. Install it with: brew install ffmpeg")
    src = os.path.abspath(os.path.expanduser(a.fcpxml))
    out = os.path.abspath(os.path.expanduser(a.output))
    ext = os.path.splitext(out)[1].lower()
    if ext not in (".mp4", ".mov", ".m4v"):
        fail("output must end in .mp4, .mov or .m4v")
    if out == src:
        fail("output would overwrite the input")
    if os.path.exists(out) and not a.overwrite:
        fail(f"{out} exists. Pass --overwrite to replace it")

    try:
        root = ET.parse(src).getroot()
    except (OSError, ET.ParseError) as e:
        fail(f"can't read {src}: {e}")
    formats = {f.get("id"): f for f in root.iter("format")}
    assets = {x.get("id"): x for x in root.iter("asset")}
    seq = root.find(".//project/sequence")
    if seq is None:
        fail("no project sequence in the FCPXML")
    fmt = formats.get(seq.get("format"))
    if fmt is None or not fmt.get("frameDuration") or not fmt.get("width"):
        fail("the sequence format has no frameDuration, width or height")
    w, h = int(fmt.get("width")), int(fmt.get("height"))
    fps = 1 / rtime(fmt.get("frameDuration"))
    spine = seq.find("spine")
    if spine is None:
        fail("the sequence has no spine")

    segs, at = [], Fraction(0)
    for el in spine:
        dur = rtime(el.get("duration"))
        offset = rtime(el.get("offset")) if el.get("offset") else at
        if offset < at:
            fail(f"spine element {el.get('name')!r} starts at {float(offset):.3f} s, before the one before it ends")
        if offset > at:
            segs.append({"gap": offset - at})
        if el.tag == "gap":
            segs.append({"gap": dur})
        elif el.tag == "asset-clip":
            asset = assets.get(el.get("ref"))
            rep = asset.find("media-rep") if asset is not None else None
            if rep is None or not rep.get("src"):
                fail(f"asset-clip {el.get('name')!r} has no media file")
            path = src_path(rep.get("src"))
            if not os.path.exists(path):
                fail(f"media missing: {path}")
            segs.append({
                "path": path,
                "start": rtime(el.get("start")),
                "dur": dur,
                "video": asset.get("hasVideo") != "0",
                "audio": asset.get("hasAudio") == "1",
                "still": os.path.splitext(path)[1].lower() in STILLS,
            })
        else:
            fail(f"spine element <{el.tag}> is not supported; only asset-clip and gap are rendered")
        at = offset + dur
    if not segs:
        fail("the spine is empty")

    fr = f"{fps.numerator}/{fps.denominator}"
    args, graph, n_in = ["ffmpeg", "-hide_banner", "-nostdin", "-y"], [], 0
    for i, s in enumerate(segs):
        d = f"{float(s.get('dur', s.get('gap'))):.6f}"
        if "gap" in s:
            graph.append(f"color=c=black:s={w}x{h}:r={fr}:d={d},format=yuv420p,setsar=1[v{i}]")
            graph.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={d}[a{i}]")
            continue
        if s["still"]:
            args += ["-loop", "1", "-framerate", fr, "-t", d, "-i", s["path"]]
        else:
            args += ["-ss", f"{float(s['start']):.6f}", "-t", d, "-i", s["path"]]
        if s["video"]:
            graph.append(
                f"[{n_in}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fr},format=yuv420p,"
                f"trim=duration={d},setpts=PTS-STARTPTS[v{i}]"
            )
        else:
            graph.append(f"color=c=black:s={w}x{h}:r={fr}:d={d},format=yuv420p,setsar=1[v{i}]")
        if s["audio"] and not s["still"]:
            graph.append(
                f"[{n_in}:a]aformat=sample_rates=48000:channel_layouts=stereo,"
                f"atrim=duration={d},asetpts=PTS-STARTPTS,apad=whole_dur={d}[a{i}]"
            )
        else:
            graph.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={d}[a{i}]")
        n_in += 1
    joined = "".join(f"[v{i}][a{i}]" for i in range(len(segs)))
    graph.append(f"{joined}concat=n={len(segs)}:v=1:a=1[v][a]")

    if a.codec == "hevc":
        venc = ["-c:v", "hevc_videotoolbox", "-q:v", "65", "-tag:v", "hvc1"]
    else:
        venc = ["-c:v", "libx264", "-crf", "18", "-preset", "medium"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=ext, dir=os.path.dirname(out), prefix=".render-")
    os.close(fd)
    log = os.path.splitext(out)[0] + ".render.log"
    args += ["-filter_complex", ";".join(graph), "-map", "[v]", "-map", "[a]", *venc,
             "-pix_fmt", "yuv420p", "-r", fr, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp]
    with open(log, "w") as lf:
        rc = subprocess.run(args, stdout=lf, stderr=subprocess.STDOUT).returncode
    if rc != 0:
        os.remove(tmp)
        fail(f"ffmpeg exited {rc}; log: {log}", 1)
    umask = os.umask(0)
    os.umask(umask)
    os.chmod(tmp, 0o666 & ~umask)
    os.replace(tmp, out)

    def probe(stream, entries):
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", stream, "-show_entries", entries,
                            "-of", "default=nw=1", out], capture_output=True, text=True).stdout
        return dict(line.split("=", 1) for line in r.splitlines() if "=" in line)
    vals = probe("v:0", "stream=width,height,r_frame_rate:format=duration")
    has_audio = bool(probe("a:0", "stream=codec_type"))
    got = float(vals.get("duration", 0))
    want = float(at)
    ok = (vals.get("width") == str(w) and vals.get("height") == str(h) and has_audio
          and Fraction(vals.get("r_frame_rate", "0/1")) == fps and abs(got - want) <= 2 / float(fps) + 0.05)
    print(f"{'PASS' if ok else 'FAIL'} {len(segs)} segment(s) rendered")
    print(f"size {vals.get('width')}x{vals.get('height')} (want {w}x{h}), frame rate {vals.get('r_frame_rate')} (want {fr})")
    print(f"duration {got:.3f} s (want {want:.3f} s), audio {'yes' if has_audio else 'missing'}")
    print(f"output {out}")
    print(f"log {log}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
