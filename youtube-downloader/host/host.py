"""Native messaging host for the "YouTube Downloader (yt-dlp)" Chrome extension.

Chrome starts this program and talks to it over stdin/stdout using
length-prefixed JSON messages. It downloads videos with yt-dlp into the
user's Downloads folder and reports progress back to the extension.
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

# Everything written to stdout must be a native message, so keep the real
# stdout for messages and send any stray prints to stderr.
OUT = sys.stdout.buffer
sys.stdout = sys.stderr
OUT_LOCK = threading.Lock()


def extend_path():
    """Chrome starts hosts with a minimal PATH; add the usual install locations."""
    home = Path.home()
    extra = [home / ".deno" / "bin", home / ".local" / "bin"]
    if os.name == "nt":
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        extra += [local / "Microsoft" / "WinGet" / "Links", Path("C:/ffmpeg/bin"), home / "scoop" / "shims"]
    else:
        extra += [Path("/opt/homebrew/bin"), Path("/usr/local/bin"), Path("/usr/bin")]
    parts = os.environ.get("PATH", "").split(os.pathsep)
    for p in extra:
        if str(p) not in parts and p.is_dir():
            parts.append(str(p))
    os.environ["PATH"] = os.pathsep.join(parts)


extend_path()


def send(msg):
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    with OUT_LOCK:
        OUT.write(struct.pack("<I", len(data)))
        OUT.write(data)
        OUT.flush()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack("<I", raw)[0]
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def downloads_dir():
    folder = Path.home() / "Downloads"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def ytdlp_version():
    try:
        from yt_dlp.version import __version__

        return __version__
    except Exception:
        return None


ANSI = re.compile(r"\x1b\[[0-9;]*m")


def clean_error(text):
    text = ANSI.sub("", str(text)).replace("ERROR: ", "").strip()
    return text[:400]


def build_options(quality, has_ffmpeg):
    opts = {}
    if quality == "mp3":
        if has_ffmpeg:
            opts["format"] = "ba/b"
            opts["postprocessors"] = [
                {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}
            ]
        else:
            opts["format"] = "ba[ext=m4a]/ba"
        return opts

    if not has_ffmpeg:
        # Without ffmpeg only single-file (video+audio) formats work, usually up to 360p.
        opts["format"] = "b" if quality == "best" else f"b[height<={quality}]/b"
        return opts

    if quality == "best":
        opts["format"] = "bv*+ba/b"
    else:
        h = int(quality)
        opts["format"] = (
            f"bv*[height<={h}][ext=mp4]+ba[ext=m4a]/"
            f"bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b"
        )
    opts["merge_output_format"] = "mp4"
    return opts


class QuietLogger:
    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        print(msg, file=sys.stderr)

    def error(self, msg):
        print(msg, file=sys.stderr)


def do_download(url, quality):
    try:
        import yt_dlp
    except ImportError:
        send({"type": "error", "message": "yt-dlp نصب نیست. فایل install را دوباره اجرا کنید."})
        return

    has_ffmpeg = shutil.which("ffmpeg") is not None
    if not has_ffmpeg:
        send({"type": "status", "message": "ffmpeg نصب نیست؛ کیفیت محدود خواهد بود…"})
    else:
        send({"type": "status", "message": "در حال دریافت اطلاعات ویدیو…"})

    last = {"t": 0.0}

    def progress_hook(d):
        if d.get("status") != "downloading":
            return
        now = time.time()
        if now - last["t"] < 0.25:
            return
        last["t"] = now
        info = d.get("info_dict") or {}
        if info.get("vcodec") == "none":
            stage = "صدا"
        elif info.get("acodec") == "none":
            stage = "تصویر"
        else:
            stage = ""
        send(
            {
                "type": "progress",
                "stage": stage,
                "downloaded": d.get("downloaded_bytes") or 0,
                "total": d.get("total_bytes") or d.get("total_bytes_estimate") or 0,
                "speed": d.get("speed"),
                "eta": d.get("eta"),
            }
        )

    def pp_hook(d):
        if d.get("status") != "started":
            return
        name = d.get("postprocessor", "")
        if "ExtractAudio" in name:
            send({"type": "status", "message": "در حال تبدیل به MP3…"})
        elif name == "Merger":
            send({"type": "status", "message": "در حال ترکیب صدا و تصویر…"})

    opts = {
        "outtmpl": str(downloads_dir() / "%(title).150B [%(id)s].%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "windowsfilenames": True,
        "logger": QuietLogger(),
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [pp_hook],
        "retries": 10,
        "fragment_retries": 10,
    }
    opts.update(build_options(quality, has_ffmpeg))

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            path = None
            reqs = info.get("requested_downloads") or []
            if reqs:
                path = reqs[-1].get("filepath")
            if not path:
                path = ydl.prepare_filename(info)
        send({"type": "done", "file": path})
    except Exception as e:  # yt_dlp.utils.DownloadError and anything else
        msg = clean_error(e)
        if re.search(r"403|sign in|bot|Requested format|nsig|signature", msg, re.I):
            msg += " — اگر مشکل ادامه داشت، yt-dlp را به‌روز کنید (فایل install را دوباره اجرا کنید)."
        send({"type": "error", "message": msg})


def open_folder(path):
    try:
        p = Path(path)
        if os.name == "nt":
            subprocess.Popen(["explorer", "/select,", str(p)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p.parent)])
    except Exception as e:
        print(e, file=sys.stderr)


def main():
    msg = read_message()
    if msg is None:
        return
    action = msg.get("action")

    if action == "ping":
        send(
            {
                "ytdlp": ytdlp_version(),
                "ffmpeg": shutil.which("ffmpeg") is not None,
                "deno": shutil.which("deno") is not None,
                "folder": str(downloads_dir()),
            }
        )
        return

    if action == "open-folder":
        open_folder(msg.get("path", ""))
        send({"ok": True})
        return

    if action == "download":
        worker = threading.Thread(
            target=do_download, args=(msg.get("url"), str(msg.get("quality", "best"))), daemon=True
        )
        worker.start()
        # Keep reading so a "cancel" message or a closed port stops the download.
        def watch_stdin():
            while True:
                m = read_message()
                if m is None or m.get("action") == "cancel":
                    os._exit(0)

        threading.Thread(target=watch_stdin, daemon=True).start()
        worker.join()
        sys.stderr.flush()
        os._exit(0)  # don't wait on the stdin reader thread

    send({"type": "error", "message": f"Unknown action: {action}"})


if __name__ == "__main__":
    main()
