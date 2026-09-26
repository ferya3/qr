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


def windows_registry_path():
    """PATH as currently saved in the registry (tools installed after Chrome started)."""
    try:
        import winreg
    except ImportError:
        return []
    result = []
    for root, key in (
        (winreg.HKEY_CURRENT_USER, r"Environment"),
        (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
    ):
        try:
            with winreg.OpenKey(root, key) as k:
                value, _ = winreg.QueryValueEx(k, "Path")
                result += [os.path.expandvars(x) for x in value.split(";") if x]
        except OSError:
            pass
    return [Path(x) for x in result]


def extend_path():
    """Chrome starts hosts with the PATH it had when it launched (often minimal);
    add the usual install locations for ffmpeg and deno."""
    home = Path.home()
    extra = [home / ".deno" / "bin", home / ".local" / "bin"]
    if os.name == "nt":
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        winget = local / "Microsoft" / "WinGet"
        extra += windows_registry_path()
        extra += [winget / "Links", Path("C:/ffmpeg/bin"), home / "scoop" / "shims"]
        # winget "portable" packages live in versioned folders
        for exe in ("deno.exe", "ffmpeg.exe"):
            for found in list((winget / "Packages").glob(f"*/{exe}")) + list(
                (winget / "Packages").glob(f"*/*/bin/{exe}")
            ):
                extra.append(found.parent)
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

    # If the requested quality isn't offered, fall back to whatever is available.
    fallbacks = [opts["format"]]
    if has_ffmpeg and quality != "mp3":
        fallbacks += ["bv*+ba/b", "b/bv*"]
    elif quality != "mp3":
        fallbacks += ["b/best"]
    else:
        fallbacks += ["ba/b/best"]

    last_error = None
    for i, fmt in enumerate(fallbacks):
        opts["format"] = fmt
        if i:
            send({"type": "status", "message": "کیفیت انتخابی موجود نبود؛ دانلود با بهترین کیفیت موجود…"})
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
            return
        except Exception as e:  # yt_dlp.utils.DownloadError and anything else
            last_error = clean_error(e)
            if "Requested format is not available" not in last_error:
                break

    msg = last_error or "خطای نامشخص"
    missing = [t for t in ("deno", "ffmpeg") if not shutil.which(t)]
    if "Requested format is not available" in msg:
        msg = "yt-dlp هیچ فرمت قابل دانلودی برای این ویدیو پیدا نکرد."
        if missing:
            msg += f" برنامه‌های نصب‌نشده: {', '.join(missing)} — آن‌ها را نصب کنید و کروم را کامل ببندید و دوباره باز کنید."
        else:
            msg += " yt-dlp را به‌روز کنید (فایل install را دوباره اجرا کنید)."
    elif re.search(r"403|sign in|bot|nsig|signature|challenge", msg, re.I):
        msg += " — yt-dlp را به‌روز کنید (فایل install را دوباره اجرا کنید)."
        if "deno" in missing:
            msg += " همچنین deno را نصب کنید."
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
