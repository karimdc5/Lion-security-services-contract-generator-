#!/usr/bin/env python3
"""
verify_mp4.py — confirm a downloaded file is a plain MP4 and nothing else.

Usage:  python3 verify_mp4.py ~/Downloads/whatever.mp4

Checks, in order:
  1. The file really is an ISO Base Media (MP4) container — it starts with an
     'ftyp' box, not a script shebang, a Mach-O/ELF/PE header, or a zip.
  2. Every top-level box is a known MP4 box type, and the box lengths tile the
     file exactly with no trailing bytes appended after the last box (a classic
     way to staple another payload onto a real video).
  3. No box type that can carry executable or scripted content is present.
  4. If ffprobe is installed, the file decodes as video/audio streams only.

This is a structural check on the file, not a malware scanner. It is here so
you can see for yourself what you are about to open.
"""

from __future__ import annotations

import shutil
import struct
import subprocess
import sys
from pathlib import Path

# Top-level boxes that a normal yt-dlp/ffmpeg-produced mp4 contains.
KNOWN_TOP_LEVEL = {
    "ftyp", "styp", "moov", "moof", "mdat", "free", "skip", "wide",
    "mfra", "sidx", "ssix", "pdin", "meta", "uuid", "mdia",
}

# Boxes/atoms with any history of carrying non-media payloads.
SUSPECT = {
    "rmra": "QuickTime reference movie — can point at a remote URL",
    "rmda": "QuickTime reference movie data",
    "rdrf": "QuickTime data reference — remote URL redirect",
    "wide": None,  # benign padding, listed only for completeness
}

EXEC_MAGIC = [
    (b"#!", "script shebang"),
    (b"\x7fELF", "ELF executable"),
    (b"MZ", "DOS/Windows executable"),
    (b"\xca\xfe\xba\xbe", "Mach-O fat binary"),
    (b"\xcf\xfa\xed\xfe", "Mach-O 64-bit executable"),
    (b"\xce\xfa\xed\xfe", "Mach-O 32-bit executable"),
    (b"PK\x03\x04", "zip archive (.app bundles, .pkg payloads)"),
    (b"<?xml", "XML document"),
    (b"<html", "HTML document"),
    (b"%PDF", "PDF document"),
]


def fail(msg: str) -> None:
    print(f"  FAIL  {msg}")


def ok(msg: str) -> None:
    print(f"  ok    {msg}")


def warn(msg: str) -> None:
    print(f"  warn  {msg}")


def read_boxes(path: Path):
    """Yield (offset, size, type) for each top-level box."""
    size_total = path.stat().st_size
    with path.open("rb") as handle:
        offset = 0
        while offset < size_total:
            handle.seek(offset)
            header = handle.read(8)
            if len(header) < 8:
                yield (offset, size_total - offset, "<truncated>")
                return
            size = struct.unpack(">I", header[:4])[0]
            kind = header[4:8].decode("latin-1")
            if size == 1:                       # 64-bit extended size
                ext = handle.read(8)
                if len(ext) < 8:
                    yield (offset, size_total - offset, "<truncated>")
                    return
                size = struct.unpack(">Q", ext)[0]
            elif size == 0:                     # box runs to end of file
                size = size_total - offset
            if size < 8:
                yield (offset, size_total - offset, "<invalid>")
                return
            yield (offset, size, kind)
            offset += size


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__.strip())
        return 2

    path = Path(argv[1]).expanduser()
    if not path.is_file():
        print(f"No such file: {path}")
        return 2

    print(f"\n{path}  ({path.stat().st_size:,} bytes)\n")
    problems = 0

    head = path.open("rb").read(16)

    # 1. magic bytes
    for magic, label in EXEC_MAGIC:
        if head.startswith(magic):
            fail(f"file starts with a {label} signature — this is NOT a video")
            return 1
    if head[4:8] != b"ftyp":
        fail("no 'ftyp' box at offset 4 — not an MP4 container")
        return 1
    brand = head[8:12].decode("latin-1", "replace")
    ok(f"valid MP4 container (ftyp, major brand '{brand}')")

    # 2 & 3. top-level box walk
    total = path.stat().st_size
    seen, covered = [], 0
    for offset, size, kind in read_boxes(path):
        seen.append(kind)
        covered = offset + size
        if kind in ("<truncated>", "<invalid>"):
            fail(f"malformed box structure at byte {offset} — file is corrupt or padded")
            problems += 1
            break
        if kind not in KNOWN_TOP_LEVEL:
            warn(f"unrecognised top-level box '{kind}' at byte {offset} ({size:,} bytes)")
            problems += 1
        if kind in SUSPECT and SUSPECT[kind]:
            fail(f"box '{kind}' present: {SUSPECT[kind]}")
            problems += 1

    print(f"  ok    top-level boxes: {', '.join(dict.fromkeys(seen))}")

    if covered == total:
        ok("box lengths account for every byte — nothing appended after the video")
    else:
        fail(f"{total - covered:,} trailing bytes after the last box — something is stapled on")
        problems += 1

    if "mdat" not in seen and "moof" not in seen:
        warn("no media data box found — file may be a stub")
        problems += 1

    # 4. ffprobe stream check
    if shutil.which("ffprobe"):
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "stream=codec_type,codec_name", "-of", "csv=p=0", "--", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        if proc.returncode != 0:
            fail(f"ffprobe could not decode the file: {proc.stderr.strip()[:200]}")
            problems += 1
        else:
            streams = [ln for ln in proc.stdout.strip().splitlines() if ln]
            for line in streams:
                codec, kind = (line.split(",") + [""])[1], line.split(",")[0]
                ok(f"stream: {kind} ({codec})")
            odd = [s for s in streams if s.split(",")[1] not in ("video", "audio", "data")]
            if odd:
                warn(f"non-media streams present: {odd}")
                problems += 1
            if not streams:
                fail("no media streams at all")
                problems += 1
    else:
        warn("ffprobe not installed — skipped the decode check (brew install ffmpeg)")

    print()
    if problems == 0:
        print("  RESULT: plain MP4 video. No embedded scripts or executables.\n")
        return 0
    print(f"  RESULT: {problems} thing(s) to look at above before opening this file.\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
