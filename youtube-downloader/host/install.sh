#!/bin/sh
# macOS / Linux installer for the YouTube Downloader native host.
cd "$(dirname "$0")" || exit 1
PY=$(command -v python3 || true)
if [ -z "$PY" ]; then
  echo "Python 3 is not installed."
  echo "macOS:  brew install python   (or install from https://www.python.org/downloads/)"
  exit 1
fi
"$PY" install.py
