#!/bin/sh
# S8: content fingerprint of a session store (hash only: sha256 over the sorted
# "sha256  path" lines), plus file count and size in KB. Prints no names.
set -eu
DIR=${1:?store dir}
cd "$DIR"
printf '%s files=%s kb=%s\n' "$(find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64)" "$(find . -type f | wc -l | tr -d ' ')" "$(du -sk . | cut -f1)"
