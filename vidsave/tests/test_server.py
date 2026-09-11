#!/usr/bin/env python3
"""
Offline tests. A stub `yt-dlp` on PATH stands in for the real one, so these
run without touching the network or either platform.

    python3 tests/test_server.py
"""

from __future__ import annotations

import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

STUB = r'''#!/usr/bin/env python3
"""Stub yt-dlp. Behaviour is chosen by a marker in the URL."""
import sys, os, struct, pathlib
args = sys.argv[1:]
url = args[-1]
outdir = pathlib.Path(args[args.index("-P") + 1]) if "-P" in args else pathlib.Path(".")

if "1001" in url:
    sys.stderr.write("ERROR: [Instagram] xyz: This video is private\n"); sys.exit(1)
if "1002" in url:
    sys.stderr.write("ERROR: [twitter] 1: No status found with that ID (404 Not Found)\n"); sys.exit(1)
if "1003" in url:
    sys.stderr.write("ERROR: age-restricted; confirm your age to continue\n"); sys.exit(1)
if "1004" in url:
    sys.stderr.write("ERROR: something nobody has a rule for\n"); sys.exit(1)
if "1005" in url:
    (outdir / "clip.webm").write_bytes(b"x" * 64); sys.exit(0)
if "1006" in url:
    sys.exit(0)

# Minimal but structurally valid mp4: ftyp + free + mdat.
def box(kind, payload):
    return struct.pack(">I", 8 + len(payload)) + kind + payload
data = box(b"ftyp", b"isom" + struct.pack(">I", 512) + b"isomiso2mp41")
data += box(b"free", b"")
data += box(b"mdat", b"\0" * 2048)
(outdir / "Funny Clip - Someone's cat!!.mp4").write_bytes(data)
sys.exit(0)
'''

FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")
        FAILURES.append(label)


def main() -> int:
    bindir = Path(tempfile.mkdtemp(prefix="vidsave-stub-"))
    stub = bindir / "yt-dlp"
    stub.write_text(STUB)
    stub.chmod(0o755)
    os.environ["PATH"] = f"{bindir}:{os.environ.get('PATH', '')}"

    import server  # noqa: E402  (imported after PATH is set)

    server.app.config["TESTING"] = False
    client = server.app.test_client()

    print("\nURL validation")
    good = [
        "https://www.instagram.com/reel/Cx1y2Z3aBcD/",
        "https://instagram.com/p/Cx1y2Z3aBcD/?igsh=abc",
        "https://www.instagram.com/someuser/reel/Cx1y2Z3aBcD/",
        "https://instagram.com/tv/Cx1y2Z3aBcD",
        "https://x.com/jack/status/20",
        "https://twitter.com/jack/status/1234567890123456789?s=20",
        "https://mobile.twitter.com/jack/status/1234567890",
    ]
    for url in good:
        try:
            server.validate_url(url)
            check(f"accepts {url[:52]}", True)
        except server.UserError as exc:
            check(f"accepts {url[:52]}", False, exc.message)

    bad = [
        "https://evil.example.com/x",
        "https://instagram.com.evil.com/reel/abcdef",
        "https://x.com/jack",
        "https://youtube.com/watch?v=abc",
        "file:///etc/passwd",
        "https://x.com/jack/status/20; rm -rf /",
        "",
        "https://instagram.com/reel/abc\nhttps://evil.com/",
    ]
    for url in bad:
        try:
            server.validate_url(url)
            check(f"rejects {url[:52]!r}", False, "was accepted")
        except server.UserError:
            check(f"rejects {url[:52]!r}", True)

    print("\nFilename sanitising")
    sanitised = server.safe_filename("../../etc/passwd")
    check("strips path separators and traversal",
          "/" not in sanitised and ".." not in sanitised, sanitised)
    check("forces .mp4", server.safe_filename("clip.webm").endswith(".mp4"))
    check("falls back on empty", server.safe_filename("///") == "video.mp4",
          server.safe_filename("///"))
    check("drops quotes that would break the header",
          '"' not in server.safe_filename('a"b; drop.mp4'))

    print("\nError mapping")
    cases = [
        ("1001", "private", "private"),
        ("1002", "deleted", "does not exist"),
        ("1003", "age-restricted", "age-restricted"),
    ]
    for status_id, marker, expect in cases:
        response = client.post(
            "/prepare", json={"url": f"https://x.com/u/status/{status_id}"}
        )
        body = response.get_json()
        check(f"{marker} -> clear error",
              response.status_code == 422 and expect in body["error"],
              f"{response.status_code} {body}")
        check(f"{marker} -> not reported as success", body.get("ok") is False)

    response = client.post("/prepare", json={"url": "https://x.com/u/status/1004"})
    body = response.get_json()
    check("unmapped error surfaces yt-dlp's own text",
          response.status_code == 422 and "yt-dlp said" in body["hint"], str(body))

    response = client.post("/prepare", json={"url": "https://x.com/u/status/1006"})
    check("no output file is an error, not a fake success",
          response.status_code == 422 and response.get_json()["ok"] is False)

    print("\nHappy path")
    response = client.post("/prepare", json={"url": "https://x.com/jack/status/20"})
    body = response.get_json()
    check("prepare succeeds", response.status_code == 200 and body["ok"] is True, str(body))
    token = body["token"]
    check("filename is sanitised ascii .mp4",
          body["filename"].endswith(".mp4") and body["filename"].isascii(),
          body["filename"])

    response = client.get(f"/file/{token}")
    check("serves 200", response.status_code == 200)
    check("Content-Type is video/mp4",
          response.headers["Content-Type"] == "video/mp4",
          response.headers.get("Content-Type"))
    disposition = response.headers.get("Content-Disposition", "")
    check("Content-Disposition is attachment",
          disposition.startswith("attachment; filename="), disposition)
    check("nosniff set", response.headers.get("X-Content-Type-Options") == "nosniff")
    payload = response.get_data()
    check("body is an mp4 (ftyp box)", payload[4:8] == b"ftyp", repr(payload[:16]))
    check("Content-Length matches body",
          int(response.headers["Content-Length"]) == len(payload))

    response = client.get(f"/file/{token}")
    check("token is single use", response.status_code == 404)

    check("temp dir cleaned up after send",
          not any(Path(tempfile.gettempdir()).glob("vidsave-*/*.mp4")))

    print("\nNon-mp4 handling")
    response = client.post("/prepare", json={"url": "https://x.com/u/status/1005"})
    body = response.get_json()
    check("webm-only is refused rather than mislabelled",
          response.status_code == 422 and "not mp4" in body["error"], str(body))

    print("\nNo-JS form path")
    response = client.post("/download", data={"url": "https://x.com/jack/status/20"})
    check("/download returns attachment",
          response.status_code == 200
          and response.headers["Content-Disposition"].startswith("attachment;"),
          str(response.status_code))

    response = client.post("/download", data={"url": "https://evil.example.com/"})
    check("/download rejects bad host with an HTML error page",
          response.status_code == 400 and b"not a supported URL" in response.get_data())

    print("\nPages")
    check("index renders", client.get("/").status_code == 200)
    check("health renders", client.get("/health").status_code == 200)

    print("\nverify_mp4 on a real file and on a tampered one")
    work = Path(tempfile.mkdtemp(prefix="vidsave-verify-"))
    clean = work / "clean.mp4"
    clean.write_bytes(payload)
    result = subprocess.run(
        [sys.executable, str(ROOT / "verify_mp4.py"), str(clean)],
        capture_output=True, text=True,
    )
    check("verifier passes a clean mp4", result.returncode == 0, result.stdout)

    stapled = work / "stapled.mp4"
    stapled.write_bytes(payload + b"#!/bin/sh\necho pwned\n")
    result = subprocess.run(
        [sys.executable, str(ROOT / "verify_mp4.py"), str(stapled)],
        capture_output=True, text=True,
    )
    check("verifier catches appended payload",
          result.returncode == 1 and "trailing bytes" in result.stdout, result.stdout)

    script = work / "notavideo.mp4"
    script.write_bytes(b"#!/bin/sh\necho pwned\n")
    result = subprocess.run(
        [sys.executable, str(ROOT / "verify_mp4.py"), str(script)],
        capture_output=True, text=True,
    )
    check("verifier catches a script wearing an .mp4 name",
          result.returncode == 1 and "shebang" in result.stdout, result.stdout)

    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(bindir, ignore_errors=True)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failing check(s): " + "; ".join(FAILURES) + "\n")
        return 1
    print("all checks passed\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
