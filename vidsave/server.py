#!/usr/bin/env python3
"""
vidsave - a tiny local-only video saver for Instagram and X/Twitter.

Runs a Flask server on 127.0.0.1, shells out to yt-dlp, and serves the
resulting file back with attachment headers so Safari saves it to the
Downloads folder instead of playing it inline.

No third-party service, no ads, no telemetry, no analytics. The only
outbound traffic is yt-dlp talking to instagram.com / x.com.
"""

from __future__ import annotations

import argparse
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

# How long yt-dlp is allowed to run for a single request, in seconds.
FETCH_TIMEOUT = int(os.environ.get("VIDSAVE_TIMEOUT", "300"))

# Refuse anything larger than this. Guards against accidentally pulling a
# multi-hour livestream onto the disk.
MAX_FILESIZE = os.environ.get("VIDSAVE_MAX_FILESIZE", "1G")

# How long a prepared file stays on disk waiting to be picked up.
TOKEN_TTL = 600

# Only one yt-dlp process at a time. This is a single-user tool; running
# several in parallel just gets the account rate-limited faster.
_fetch_lock = threading.Semaphore(1)

# token -> {"dir": Path, "path": Path, "filename": str, "expires": float}
_pending: dict[str, dict] = {}
_pending_lock = threading.Lock()

app = Flask(__name__)

# --------------------------------------------------------------------------
# URL validation
# --------------------------------------------------------------------------

# Deliberately strict. Anything that is not a recognised single-post URL on
# one of the two supported sites is rejected before yt-dlp is ever invoked,
# so the tool cannot be pointed at arbitrary hosts.
URL_PATTERNS = (
    # instagram.com/reel/<id>, /reels/<id>, /p/<id>, /tv/<id>
    # also matches the /<username>/reel/<id> form Instagram now uses.
    re.compile(
        r"^https?://(?:www\.)?instagram\.com/"
        r"(?:[A-Za-z0-9._]{1,40}/)?"
        r"(?:reel|reels|p|tv)/[A-Za-z0-9_-]{5,}/?"
        r"(?:\?.*)?$",
        re.IGNORECASE,
    ),
    # x.com / twitter.com / mobile + vx variants -> /<user>/status/<id>
    re.compile(
        r"^https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/"
        r"[A-Za-z0-9_]{1,20}/status/[0-9]{1,25}/?"
        r"(?:\?.*)?$",
        re.IGNORECASE,
    ),
)


class UserError(Exception):
    """An error worth showing verbatim to the person using the tool."""

    def __init__(self, message: str, hint: str = "", status: int = 400):
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.status = status


def validate_url(raw: str) -> str:
    url = (raw or "").strip()
    if not url:
        raise UserError("No URL given.", "Paste an Instagram or X/Twitter post link.")
    if len(url) > 2048:
        raise UserError("That URL is implausibly long.", "Paste the plain post link.")
    if "\n" in url or "\r" in url:
        raise UserError("That URL contains line breaks.", "Paste a single link.")
    for pattern in URL_PATTERNS:
        if pattern.match(url):
            return url
    raise UserError(
        "That is not a supported URL.",
        "Supported: instagram.com/reel/…, instagram.com/p/…, "
        "x.com/<user>/status/… and twitter.com/<user>/status/…",
    )


# --------------------------------------------------------------------------
# yt-dlp invocation
# --------------------------------------------------------------------------


def ytdlp_binary() -> str:
    found = shutil.which("yt-dlp")
    if not found:
        raise UserError(
            "yt-dlp is not installed (or not on this server's PATH).",
            "Install it with:  brew install yt-dlp   (see README.md)",
            status=500,
        )
    return found


def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


# Patterns matched against yt-dlp's stderr, in order. First hit wins.
ERROR_RULES: tuple[tuple[str, str, str], ...] = (
    (
        r"private|only available to|not available to you|restricted video",
        "That post is private.",
        "Private accounts and restricted posts cannot be fetched without "
        "signing in. See the 'Private posts' section of README.md — note the "
        "caveats before using your own cookies.",
    ),
    (
        r"login required|requires login|sign in|authentication|rate-?limit|"
        r"429|checkpoint|challenge_required",
        "The site asked for a login or rate-limited this request.",
        "Instagram throttles anonymous requests aggressively. Wait a few "
        "minutes and try again; if it persists, the post likely needs an "
        "account to view.",
    ),
    (
        r"age.?restrict|sensitive|nsfw|confirm your age",
        "That post is age-restricted.",
        "Age-gated posts require a signed-in session. Nothing was downloaded.",
    ),
    (
        r"not found|404|does not exist|unavailable|been deleted|removed|"
        r"no longer available|suspended",
        "That post does not exist, was deleted, or the account is gone.",
        "Double-check the link by opening it in Safari first.",
    ),
    (
        r"no video|there.s no video|unsupported url|no media",
        "That post has no downloadable video.",
        "Image-only posts and text-only tweets have nothing to save.",
    ),
    (
        r"file is larger than max-filesize|max-?filesize",
        f"That video is larger than the {MAX_FILESIZE} size limit.",
        "Raise it with VIDSAVE_MAX_FILESIZE=2G if you really want it.",
    ),
    (
        r"unable to download|temporary failure|connection|timed out|"
        r"network is unreachable|ssl",
        "Network error while contacting the site.",
        "Check your connection and try again.",
    ),
    (
        r"geo.?restrict|not available in your country",
        "That post is not available in your region.",
        "Nothing was downloaded.",
    ),
)


def explain_failure(stderr: str) -> UserError:
    blob = stderr.lower()
    for pattern, message, hint in ERROR_RULES:
        if re.search(pattern, blob):
            return UserError(message, hint, status=422)
    # Nothing matched. Surface the real yt-dlp error rather than inventing one.
    tail = [ln for ln in stderr.strip().splitlines() if ln.strip()]
    detail = tail[-1] if tail else "yt-dlp produced no error output."
    return UserError(
        "yt-dlp could not fetch that video.",
        f"yt-dlp said: {detail[:400]}",
        status=422,
    )


def safe_filename(name: str) -> str:
    """Return an ASCII, path-free, .mp4-suffixed filename."""
    stem = Path(name).stem
    stem = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode()
    stem = re.sub(r"[^A-Za-z0-9._ -]+", "", stem).strip(" .-")
    stem = re.sub(r"\s+", " ", stem)[:80]
    return f"{stem}.mp4" if stem else "video.mp4"


def run_ytdlp(url: str) -> tuple[Path, Path, str]:
    """Download `url` into a fresh temp dir. Returns (tmpdir, file, filename)."""
    binary = ytdlp_binary()
    tmpdir = Path(tempfile.mkdtemp(prefix="vidsave-"))

    if have_ffmpeg():
        # Best video + best audio, remuxed to mp4.
        fmt = "bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b"
    else:
        # No ffmpeg: only take streams that are already a single mp4 file,
        # otherwise we would hand back a half-muxed mess.
        fmt = "b[ext=mp4]/b"

    cmd = [
        binary,
        "--no-playlist",          # a /p/ link can be a carousel; take one item
        "--playlist-items", "1",
        "--no-continue",
        "--no-part",
        "--no-mtime",
        "--no-cache-dir",
        "--no-exec",              # never run post-download commands
        "--no-config",            # ignore any yt-dlp config file on this machine
        "--restrict-filenames",
        "--max-filesize", MAX_FILESIZE,
        "--socket-timeout", "30",
        "--retries", "3",
        "-f", fmt,
        "-o", "%(title).80B.%(ext)s",
        "-P", str(tmpdir),
    ]
    if have_ffmpeg():
        cmd += ["--merge-output-format", "mp4"]
    cmd += ["--", url]            # '--' stops the URL being read as a flag

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=FETCH_TIMEOUT,
            shell=False,          # no shell: the URL is never interpreted
            cwd=str(tmpdir),
            env={"PATH": os.environ.get("PATH", ""), "HOME": str(tmpdir)},
        )
    except subprocess.TimeoutExpired:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise UserError(
            f"Timed out after {FETCH_TIMEOUT}s.",
            "The video may be very large, or the site is not responding.",
            status=504,
        )

    files = [p for p in tmpdir.iterdir() if p.is_file() and p.stat().st_size > 0]

    if proc.returncode != 0 or not files:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise explain_failure(proc.stderr or proc.stdout)

    media = max(files, key=lambda p: p.stat().st_size)
    if media.suffix.lower() not in (".mp4", ".m4v", ".mov"):
        # Anything else (webm, mkv) would not play as a .mp4. Say so rather
        # than relabelling the extension and pretending it worked.
        detail = media.suffix or "no extension"
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise UserError(
            f"The only available stream is {detail}, not mp4.",
            "Install ffmpeg so it can be remuxed to mp4 (see README.md).",
            status=422,
        )

    return tmpdir, media, safe_filename(media.name)


# --------------------------------------------------------------------------
# Pending-file bookkeeping
# --------------------------------------------------------------------------


def reap_expired() -> None:
    now = time.time()
    with _pending_lock:
        dead = [t for t, e in _pending.items() if e["expires"] < now]
        for token in dead:
            entry = _pending.pop(token)
            shutil.rmtree(entry["dir"], ignore_errors=True)


def stash(tmpdir: Path, media: Path, filename: str) -> tuple[str, int]:
    reap_expired()
    token = secrets.token_urlsafe(24)
    with _pending_lock:
        _pending[token] = {
            "dir": tmpdir,
            "path": media,
            "filename": filename,
            "expires": time.time() + TOKEN_TTL,
        }
    return token, media.stat().st_size


def attachment_response(media: Path, filename: str, tmpdir: Path | None) -> Response:
    """Stream `media` with the headers that make Safari save, not play."""
    size = media.stat().st_size
    handle = media.open("rb")

    def stream():
        try:
            while True:
                chunk = handle.read(256 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            handle.close()
            if tmpdir is not None:
                shutil.rmtree(tmpdir, ignore_errors=True)

    response = Response(stream(), mimetype="video/mp4")
    response.headers["Content-Type"] = "video/mp4"
    # The two headers that matter: 'attachment' tells Safari to save the file
    # to Downloads rather than hand it to the inline video player.
    response.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    response.headers["Content-Length"] = str(size)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Accept-Ranges"] = "none"
    return response


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------


@app.after_request
def security_headers(response: Response) -> Response:
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Frame-Options", "DENY")
    return response


@app.get("/")
def index():
    return render_template(
        "index.html",
        ffmpeg=have_ffmpeg(),
        ytdlp=shutil.which("yt-dlp") is not None,
    )


@app.get("/health")
def health():
    return jsonify(
        ok=True,
        ytdlp=shutil.which("yt-dlp"),
        ffmpeg=shutil.which("ffmpeg"),
        max_filesize=MAX_FILESIZE,
        timeout=FETCH_TIMEOUT,
    )


@app.post("/prepare")
def prepare():
    """Fetch the video, hold it, and hand back a single-use download token.

    Split into two steps so the page can show honest progress and show real
    errors as text, instead of a navigation that either downloads or dumps an
    error page into the tab.
    """
    payload = request.get_json(silent=True) or {}
    url = validate_url(payload.get("url", ""))

    if not _fetch_lock.acquire(blocking=False):
        raise UserError(
            "Another download is already running.",
            "Wait for it to finish, then try again.",
            status=429,
        )
    try:
        tmpdir, media, filename = run_ytdlp(url)
    finally:
        _fetch_lock.release()

    token, size = stash(tmpdir, media, filename)
    return jsonify(ok=True, token=token, filename=filename, bytes=size)


@app.get("/file/<token>")
def file(token: str):
    """Serve a prepared file exactly once, then delete it."""
    reap_expired()
    with _pending_lock:
        entry = _pending.pop(token, None)
    if entry is None:
        raise UserError(
            "That download link has already been used or has expired.",
            "Paste the post URL again.",
            status=404,
        )
    return attachment_response(entry["path"], entry["filename"], entry["dir"])


@app.route("/download", methods=["GET", "POST"])
def download():
    """One-shot fetch-and-send. Works with JavaScript disabled, and is the
    endpoint to use from a shortcut or `curl -OJ`."""
    url = request.values.get("url", "")
    url = validate_url(url)

    if not _fetch_lock.acquire(blocking=False):
        raise UserError("Another download is already running.", status=429)
    try:
        tmpdir, media, filename = run_ytdlp(url)
    finally:
        _fetch_lock.release()

    return attachment_response(media, filename, tmpdir)


@app.errorhandler(UserError)
def handle_user_error(err: UserError):
    wants_json = request.path in ("/prepare",) or "application/json" in (
        request.headers.get("Accept", "")
    )
    if wants_json:
        return jsonify(ok=False, error=err.message, hint=err.hint), err.status
    return (
        render_template("error.html", message=err.message, hint=err.hint),
        err.status,
    )


@app.errorhandler(500)
def handle_500(err):  # pragma: no cover - defensive
    return (
        render_template(
            "error.html",
            message="The local server hit an unexpected error.",
            hint="Check the terminal window running server.py for a traceback.",
        ),
        500,
    )


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Instagram / X video saver.")
    parser.add_argument("--port", type=int, default=8723)
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind address. Leave as 127.0.0.1 unless you have read the "
        "'Using it from iPhone' section of README.md.",
    )
    args = parser.parse_args()

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(
            "\n  !! Binding to %s, not loopback.\n"
            "  !! Anyone on this network can make this machine download\n"
            "  !! arbitrary Instagram/X videos. Only do this on a network\n"
            "  !! you control, and stop the server when you are done.\n"
            % args.host,
            file=sys.stderr,
        )

    if not shutil.which("yt-dlp"):
        print("  !! yt-dlp not found on PATH — see README.md", file=sys.stderr)
    if not have_ffmpeg():
        print(
            "  !! ffmpeg not found on PATH — X/Twitter videos that ship video\n"
            "  !! and audio as separate streams will be rejected rather than\n"
            "  !! saved without sound. See README.md.",
            file=sys.stderr,
        )

    print(f"\n  vidsave is running at  http://{args.host}:{args.port}/\n")
    app.run(host=args.host, port=args.port, threaded=True, debug=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
