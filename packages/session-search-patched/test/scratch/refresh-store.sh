#!/bin/sh
# S8: replace <root>/home/.dsh/sessions of a scratch root with a fresh copy of
# the read-only store copy (cp -Rp keeps mtimes). Gate: scratch-home.mjs must
# accept the root's DSH_HOME, and the target must end in /home/.dsh/sessions
# inside that root. The source is only read.
set -eu
export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"
ROOT=${1:?scratch root}
STORE_SRC=${SSP_STORE_SRC:-/tmp/ssp-scratch-store/sessions}
node scripts/scratch-home.mjs check "$ROOT/home/.dsh" >&2
DEST="$ROOT/home/.dsh/sessions"
: "${DEST:?}"
case "$DEST" in
  /private/var/folders/*/T/dsh-scratch-*/home/.dsh/sessions|/var/folders/*/T/dsh-scratch-*/home/.dsh/sessions) ;;
  *) echo "refusing: $DEST is not a scratch store path" >&2; exit 2 ;;
esac
echo "replacing $DEST" >&2
rm -rf -- "$DEST"
cp -Rp "$STORE_SRC" "$DEST"
