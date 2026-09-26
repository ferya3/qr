"""Removes the native messaging host registration (yt-dlp itself is left installed)."""
import os
import sys
from pathlib import Path

HOST_NAME = "com.ytdl.downloader"

if os.name == "nt":
    import winreg

    for key in (
        r"Software\Google\Chrome\NativeMessagingHosts",
        r"Software\Microsoft\Edge\NativeMessagingHosts",
        r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
        r"Software\Chromium\NativeMessagingHosts",
    ):
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, f"{key}\\{HOST_NAME}")
        except OSError:
            pass
else:
    home = Path.home()
    base = home / "Library" / "Application Support" if sys.platform == "darwin" else home / ".config"
    for f in base.glob(f"**/NativeMessagingHosts/{HOST_NAME}.json"):
        f.unlink()
print("Uninstalled.")
