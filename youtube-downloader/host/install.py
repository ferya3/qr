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


def check_tools():
    step("Checking optional tools ...")
    sys.path.insert(0, str(HERE))
    import host  # noqa: E402  (extends PATH the same way the host does)

    ok = True
    for tool, why in (
        ("ffmpeg", "needed for 720p+ / 1080p / 4K and MP3"),
        ("deno", "needed by yt-dlp to unlock all YouTube formats"),
    ):
        if shutil.which(tool):
            print(f"   {tool}: found")
            continue
        ok = False
        print(f"   {tool}: NOT FOUND  ({why})")
        if os.name == "nt":
            pkg = "Gyan.FFmpeg" if tool == "ffmpeg" else "DenoLand.Deno"
            print(f"      install with:  winget install {pkg}")
        elif sys.platform == "darwin":
            print(f"      install with:  brew install {tool}")
        else:
            print(f"      install with your package manager, e.g.  sudo apt install {tool}"
                  if tool == "ffmpeg" else "      install with:  curl -fsSL https://deno.land/install.sh | sh")
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
        print("   Install the missing tools above, then restart Chrome.")
    print("   Do not move this folder; if you do, run the installer again.")


if __name__ == "__main__":
    main()
