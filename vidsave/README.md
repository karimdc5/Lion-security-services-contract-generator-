# vidsave

A small local-only tool for saving Instagram and X/Twitter videos as `.mp4`
files, triggered from Safari, landing in your Downloads folder.

Replaces sites like x-downloader.com / saveclip.app. Nothing here shows ads,
injects fake download buttons, pushes browser extensions, or sends your URLs to
a third party. The only outbound traffic is `yt-dlp` talking directly to
`instagram.com` or `x.com`; the file goes from that site, to your machine, to
your Downloads folder.

```
vidsave/
├── server.py                 Flask server (binds 127.0.0.1 by default)
├── templates/index.html      the one page you bookmark
├── templates/error.html      plain error page for the no-JavaScript path
├── verify_mp4.py             checks a downloaded file is a plain video
├── run.sh                    creates the venv on first run, then starts it
├── com.vidsave.local.plist   launchd job, for the persistent setup
└── tests/test_server.py      offline tests (stub yt-dlp, no network)
```

---

## 1. Setup

Everything below is one-time.

**Install Homebrew** (skip if you have it — `brew --version` answers):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

**Install yt-dlp and ffmpeg:**

```bash
brew install yt-dlp ffmpeg
```

`ffmpeg` is not optional in practice. X/Twitter serves HLS streams where video
and audio are separate; without ffmpeg there is nothing to mux them back
together. This tool refuses such a download rather than quietly handing you a
silent video — see [Errors](#6-what-the-errors-mean).

Verify both are on your PATH:

```bash
yt-dlp --version    # e.g. 2025.xx.xx
ffmpeg -version | head -1
```

**Get the tool onto your machine.** Copy this `vidsave/` folder wherever you
want it — `~/vidsave` is assumed throughout:

```bash
cp -R vidsave ~/vidsave
cd ~/vidsave
```

**Start it:**

```bash
./run.sh
```

First run creates `.venv/` next to the script and installs Flask into it (only
Flask — see `requirements.txt`). Then:

```
  vidsave is running at  http://127.0.0.1:8723/
```

Open <http://127.0.0.1:8723/> in Safari and bookmark it.

Keep yt-dlp current — Instagram and X change their internals often, and a stale
yt-dlp is the single most common cause of "this used to work":

```bash
brew upgrade yt-dlp
```

---

## 2. Using it

Paste a URL, click **Download .mp4**. The page shows "Fetching…" while yt-dlp
works (a few seconds for a short clip), then Safari saves the file.

Supported URL shapes:

| Platform | Accepted |
|---|---|
| Instagram | `instagram.com/reel/<id>`, `/reels/<id>`, `/p/<id>`, `/tv/<id>`, and the `instagram.com/<user>/reel/<id>` form |
| X / Twitter | `x.com/<user>/status/<id>`, `twitter.com/<user>/status/<id>`, `mobile.twitter.com/...` |

Tracking junk on the end (`?igsh=…`, `?s=20`) is fine. Anything that is not one
of these is rejected before yt-dlp is ever launched, so the tool cannot be
pointed at an arbitrary host.

You can also skip the page entirely:

```bash
curl -OJ "http://127.0.0.1:8723/download?url=https://x.com/user/status/123"
```

That same `/download?url=…` endpoint is what to wire into an iOS Shortcut or a
Safari bookmarklet if you want one-tap saving from the share sheet.

---

## 3. Why the file downloads instead of playing in a tab

Three response headers, set in `attachment_response()` in `server.py`:

```
Content-Type: video/mp4
Content-Disposition: attachment; filename="clip.mp4"
X-Content-Type-Options: nosniff
```

`Content-Disposition: attachment` is the one that matters — it tells Safari the
response is a file to save, not a document to render, so it goes to your
Downloads folder rather than the built-in video player. `nosniff` stops Safari
second-guessing the declared type. `Accept-Ranges: none` is also set, because
range requests are what let Safari's player stream a file inline.

The filename is sanitised to ASCII, stripped of path separators and quotes, and
always given a `.mp4` extension, so it cannot escape the Downloads folder or
break the header it sits in.

Two other Safari behaviours worth knowing:

- **Safari → Settings → General → File download location** controls where it
  lands. Set it to "Downloads" (and "Ask for each download" off) if you want it
  automatic.
- On **iOS**, downloads go to Files → On My iPhone → Downloads (or iCloud
  Drive, per the same setting). From there, "Save to Photos" if you want it in
  your camera roll.

---

## 4. Running it persistently vs. on demand

**On demand (recommended).** Run `./run.sh` in a terminal when you want it,
Ctrl-C when you're done. Nothing is listening when you're not using it, which
is the smaller attack surface and the easier thing to reason about.

**Persistently**, as a login agent that starts at boot and restarts if it dies:

```bash
# 1. Edit the plist: replace every YOUR_USERNAME with the output of `whoami`
#    (and fix the paths if vidsave is not at ~/vidsave).
nano com.vidsave.local.plist

# 2. Install and start it
cp com.vidsave.local.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.vidsave.local.plist

# 3. Confirm
curl http://127.0.0.1:8723/health
tail -f ~/Library/Logs/vidsave.log
```

To stop or remove it:

```bash
launchctl unload ~/Library/LaunchAgents/com.vidsave.local.plist
rm ~/Library/LaunchAgents/com.vidsave.local.plist
```

What actually changes between the two modes:

| | On demand | Persistent |
|---|---|---|
| Listening socket | only while the terminal is open | always, from login |
| PATH | your shell's | launchd's — the plist must list Homebrew's bin dir explicitly, or yt-dlp won't be found |
| Output | in your terminal | `~/Library/Logs/vidsave.log`, which grows; rotate or truncate it occasionally |
| Failure | you see it | silent unless you check the log |
| yt-dlp upgrades | picked up next run | `launchctl kickstart -k gui/$(id -u)/com.vidsave.local` to restart after `brew upgrade` |

Either way it is bound to `127.0.0.1`, which means only your own machine can
reach it — not other devices on your Wi-Fi, not the internet.

### Using it from your iPhone

This requires exposing the server on your LAN, which is a real change in
posture: anyone on the same network who finds the port can make your Mac
download videos. Only do this on a network you control, and prefer stopping the
server when you're done.

```bash
./run.sh --host 0.0.0.0        # prints a warning; that warning is the point
```

Then browse to `http://<your-mac's-LAN-IP>:8723/` from the phone. The safer
alternative, if you have iCloud or Tailscale: leave it on `127.0.0.1`, download
on the Mac, and let the file sync.

---

## 5. What the server does and does not do

- One yt-dlp process at a time (a second concurrent request gets a clear "already
  running" error rather than queueing up and getting you rate-limited).
- yt-dlp is invoked as an argument list with `shell=False` and a `--` separator
  before the URL, so nothing in a URL can be interpreted as a shell command or
  as a yt-dlp flag.
- `--no-exec` and `--no-config` are passed, so yt-dlp will not run
  post-processing commands and will ignore any `yt-dlp.conf` sitting on the
  machine.
- Downloads go to a fresh temp directory, which is deleted the moment the file
  finishes streaming to Safari (or on any error). Nothing accumulates.
- Each prepared file gets a single-use token that expires in 10 minutes.
- Hard cap of 1 GB per download (`VIDSAVE_MAX_FILESIZE=2G` to raise it) and a
  300-second timeout (`VIDSAVE_TIMEOUT`).
- No logging of URLs to disk, no analytics, no outbound calls other than
  yt-dlp's own.

### Private posts

The tool deliberately does **not** handle login. Passing your session cookies to
yt-dlp is possible (`--cookies-from-browser safari`) but it means a background
process holding your live Instagram/X session, and platforms do flag automated
access on logged-in accounts. If you want it, you'd add that flag to `cmd` in
`run_ytdlp()` in `server.py` — but understand you're trading the main safety
property of this setup for it. The default refuses private posts with a clear
message instead.

---

## 6. What the errors mean

There are no silent failures and no fake success states. If a file is not
produced, you get an error; the page never says "done" without a file.

| Message | What happened |
|---|---|
| "That post is private." | Private account or restricted post. Nothing was downloaded. |
| "That post does not exist, was deleted, or the account is gone." | 404 from the platform. |
| "That post is age-restricted." | Age gate requires a signed-in session. |
| "The site asked for a login or rate-limited this request." | Usually Instagram throttling anonymous requests. Wait a few minutes. |
| "That post has no downloadable video." | Image-only post or text-only tweet. |
| "The only available stream is .webm, not mp4." | ffmpeg is missing, so it can't be remuxed. Install ffmpeg. |
| "That video is larger than the 1G size limit." | Raise `VIDSAVE_MAX_FILESIZE`. |
| "yt-dlp could not fetch that video." + yt-dlp's own last line | Something with no specific rule — the raw yt-dlp error is shown rather than guessed at. Usually means yt-dlp needs upgrading. |

`brew upgrade yt-dlp` fixes a surprising share of these.

---

## 7. Confirming the .mp4 is just a video

Short answer: yes, the files are plain video containers. MP4 is a passive format
— a sequence of length-prefixed "boxes" holding encoded frames and metadata.
There is no scripting layer in it, nothing that executes on open, and macOS
does not treat a `.mp4` as launchable. The danger with the ad-supported
downloader sites was never the video itself; it was the fake "Download" buttons
handing you a `.dmg` or a configuration profile instead.

To check any file for yourself:

```bash
python3 ~/vidsave/verify_mp4.py ~/Downloads/whatever.mp4
```

It checks that:

1. The file really begins with an `ftyp` box — not a shebang, Mach-O, ELF, PE,
   zip, HTML, or PDF header wearing an `.mp4` name.
2. Every top-level box is a known MP4 box type.
3. The box lengths tile the file exactly, with **no trailing bytes after the
   last box** — appending a payload to a valid video is the classic trick, and
   it shows up here as unaccounted bytes.
4. No QuickTime reference-movie boxes (`rmra`/`rdrf`) are present — those can
   point at a remote URL.
5. With ffprobe installed, the file decodes as video/audio streams only.

Sample output:

```
  ok    valid MP4 container (ftyp, major brand 'isom')
  ok    top-level boxes: ftyp, moov, free, mdat
  ok    box lengths account for every byte — nothing appended after the video
  ok    stream: video (h264)
  ok    stream: audio (aac)

  RESULT: plain MP4 video. No embedded scripts or executables.
```

It's a structural check, not a malware scanner — but for "is this thing I just
downloaded actually a video", it answers the question.

Two extra habits worth keeping:

- In Finder, turn on **View → Show Path Bar / arrange by Kind**, and enable
  "Show all filename extensions" (Finder → Settings → Advanced). A file named
  `funny.mp4.app` is then visibly not a video.
- `file ~/Downloads/whatever.mp4` gives you a second opinion from the system.

---

## 8. Keeping this personal-use only

You asked to flag anything in the setup that needs adjusting to keep this for
your own viewing. Specifically:

- **Both platforms' Terms of Service prohibit downloading without permission**,
  personal use included. That's a contract question between you and them, not a
  copyright one, and the practical risk at this scale is being rate-limited.
  Worth knowing rather than being surprised by it.
- **Saved videos are still someone else's copyrighted work.** Keeping a copy to
  watch is the ordinary personal-use case. Reposting, uploading, compiling into
  another video, or putting it anywhere public is a different thing entirely,
  and the tool can't tell the difference — that boundary is yours to hold.
- **Keep it bound to `127.0.0.1`.** The moment you run `--host 0.0.0.0` and
  leave it up, it's a service other people can use, which is a different kind of
  thing from a personal tool. The LAN mode prints a warning for this reason.
- **Don't add cookie/login support casually.** Beyond the account risk, it turns
  "save the public clip I just watched" into "access content the poster
  restricted", which is a meaningfully different act.
- **Don't add bulk or batch downloading.** The single-URL, one-at-a-time design
  is deliberate. A loop over an account's whole feed is scraping, gets you
  blocked, and is hard to describe as personal viewing.
- **Strip nothing, add nothing.** The tool doesn't remove watermarks or
  attribution metadata, which is what keeps a saved file traceable to its author
  if you ever share it with a friend.

---

## Tests

Offline, no network, stub yt-dlp:

```bash
./.venv/bin/python tests/test_server.py
```

Covers URL validation (including rejecting lookalike hosts and injection
attempts), filename sanitising, every error path, the attachment headers, the
single-use token, temp-file cleanup, and the mp4 verifier against both a clean
file and a tampered one.
