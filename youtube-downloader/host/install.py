"""Installs the native messaging host for the YouTube Downloader extension.

- installs / updates yt-dlp (with its YouTube helper packages) via pip
- writes a small launcher next to host.py that uses this exact Python
- registers the host with Chrome, Edge, Brave and Chromium
Run it again at any time to update yt-dlp.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HOST_NAME = "com.ytdl.downloader"
EXTENSION_ID = "iflbjnlbgopkphdpejopckblhkhpefka"
HERE = Path(__file__).resolve().parent


def step(msg):
    print(f"\n==> {msg}")


def install_ytdlp():
    step("Installing / updating yt-dlp ...")
    cmd = [sys.executable, "-m", "pip", "install", "-U", "--user", "yt-dlp[default]"]
    if subprocess.call(cmd) != 0:
        # Some Python installs refuse --user (venvs) or need --break-system-packages.
        alt = [sys.executable, "-m", "pip", "install", "-U", "yt-dlp[default]"]
        if subprocess.call(alt) != 0:
            subprocess.check_call(alt + ["--break-system-packages"])


def write_launcher():
    step("Creating launcher ...")
    host = HERE / "host.py"
    if os.name == "nt":
        launcher = HERE / "ytdl_host.bat"
        launcher.write_text(f'@echo off\r\n"{sys.executable}" -u "{host}" %*\r\n', encoding="utf-8")
    else:
        launcher = HERE / "ytdl_host.sh"
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" -u "{host}" "$@"\n', encoding="utf-8")
        launcher.chmod(0o755)
    return launcher


def write_manifest(launcher):
    manifest = {
        "name": HOST_NAME,
        "description": "YouTube Downloader (yt-dlp) host",
        "path": str(launcher),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
    }
    path = HERE / f"{HOST_NAME}.json"
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return path


def register(manifest_path):
    step("Registering with browsers ...")
    if os.name == "nt":
        import winreg

        browsers = {
            "Chrome": r"Software\Google\Chrome\NativeMessagingHosts",
            "Edge": r"Software\Microsoft\Edge\NativeMessagingHosts",
            "Brave": r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
            "Chromium": r"Software\Chromium\NativeMessagingHosts",
        }
        for name, key in browsers.items():
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, f"{key}\\{HOST_NAME}") as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, str(manifest_path))
            print(f"   {name}: OK")
        return

    home = Path.home()
    if sys.platform == "darwin":
        base = home / "Library" / "Application Support"
        dirs = {
            "Chrome": base / "Google" / "Chrome",
            "Edge": base / "Microsoft Edge",
            "Brave": base / "BraveSoftware" / "Brave-Browser",
            "Chromium": base / "Chromium",
        }
    else:
        base = home / ".config"
        dirs = {
            "Chrome": base / "google-chrome",
            "Edge": base / "microsoft-edge",
            "Brave": base / "BraveSoftware" / "Brave-Browser",
            "Chromium": base / "chromium",
        }
    for name, d in dirs.items():
        if name != "Chrome" and not d.exists():
            continue
        target = d / "NativeMessagingHosts"
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy(manifest_path, target / manifest_path.name)
        print(f"   {name}: {target}")


TOOL_URLS = {
    # (platform, machine) -> {tool: url}
    "win": {
        "deno": "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip",
        "ffmpeg": "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    },
    "mac-arm64": {
        "deno": "https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip",
        "ffmpeg": "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip",
    },
    "mac-x86_64": {
        "deno": "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-apple-darwin.zip",
        "ffmpeg": "https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip",
    },
    "linux": {
        "deno": "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip",
        "ffmpeg": "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
    },
}


def platform_key():
    import platform

    if os.name == "nt":
        return "win"
    if sys.platform == "darwin":
        return "mac-arm64" if platform.machine() == "arm64" else "mac-x86_64"
    return "linux"


def download_file(url, dest):
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as res, open(dest, "wb") as f:
        total = int(res.headers.get("Content-Length") or 0)
        got = 0
        while True:
            chunk = res.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total:
                print(f"\r      {got * 100 // total}%  ({got >> 20} / {total >> 20} MB)", end="", flush=True)
    print()


def extract_tool(archive, tool, bin_dir):
    """Pull <tool>(.exe) out of a zip / tar archive into bin_dir, flattening folders."""
    import tarfile
    import zipfile

    exe = tool + (".exe" if os.name == "nt" else "")
    wanted = {exe}
    if tool == "ffmpeg":
        wanted.add("ffprobe" + (".exe" if os.name == "nt" else ""))
    found = False
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as z:
            for name in z.namelist():
                base = name.rsplit("/", 1)[-1]
                if base in wanted:
                    (bin_dir / base).write_bytes(z.read(name))
                    found = found or base == exe
    else:
        with tarfile.open(archive) as t:
            for m in t.getmembers():
                base = m.name.rsplit("/", 1)[-1]
                if m.isfile() and base in wanted:
                    (bin_dir / base).write_bytes(t.extractfile(m).read())
                    found = found or base == exe
    for base in wanted:
        if (bin_dir / base).exists() and os.name != "nt":
            (bin_dir / base).chmod(0o755)
    return found


def download_tool(tool):
    url = TOOL_URLS[platform_key()][tool]
    bin_dir = HERE / "bin"
    bin_dir.mkdir(exist_ok=True)
    archive = bin_dir / ("_download" + (".tar.xz" if url.endswith(".tar.xz") else ".zip"))
    print(f"   downloading {tool} ...")
    try:
        download_file(url, archive)
        ok = extract_tool(archive, tool, bin_dir)
    except Exception as e:
        print(f"      failed: {e}")
        ok = False
    finally:
        if archive.exists():
            archive.unlink()
    return ok


def check_tools():
    step("Checking ffmpeg and deno ...")
    sys.path.insert(0, str(HERE))
    import host  # noqa: E402  (extends PATH the same way the host does, incl. ./bin)

    ok = True
    for tool in ("deno", "ffmpeg"):
        if shutil.which(tool):
            print(f"   {tool}: found ({shutil.which(tool)})")
            continue
        if download_tool(tool):
            host.extend_path()  # ./bin may not have existed at import time
        if shutil.which(tool):
            print(f"   {tool}: installed ({shutil.which(tool)})")
            continue
        ok = False
        print(f"   {tool}: COULD NOT INSTALL AUTOMATICALLY")
        if os.name == "nt":
            pkg = "Gyan.FFmpeg" if tool == "ffmpeg" else "DenoLand.Deno"
            print(f"      install it manually:  winget install {pkg}")
        elif sys.platform == "darwin":
            print(f"      install it manually:  brew install {tool}")
        else:
            print(f"      install it manually with your package manager")
    return ok


def main():
    if sys.version_info < (3, 9):
        sys.exit("Python 3.9 or newer is required.")
    install_ytdlp()
    launcher = write_launcher()
    manifest = write_manifest(launcher)
    register(manifest)
    all_ok = check_tools()
    step("Done!")
    print("   Restart Chrome, then open a YouTube video and press the red Download button.")
    if not all_ok:
        print("   Some tools are missing (see above); install them, then restart Chrome.")
    print("   Do not move this folder; if you do, run the installer again.")


if __name__ == "__main__":
    main()
