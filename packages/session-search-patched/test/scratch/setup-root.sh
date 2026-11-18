#!/bin/sh
# S8: create one scratch DSH home for the verification runs and print its root.
# Every dsh call goes through scripts/scratch-home.mjs (mkdtemp under the temp
# dir, scratch-only environment, refuses the real ~/.dsh). Run from
# packages/session-search-patched:
#   sh test/scratch/setup-root.sh <label>
# Steps: create the root, let `--dump-config` create the shipped web profile,
# select the optional session-search bundle the way the plugin manager's bundle
# switch does (append to dsh.profile.bundles), install the observer rows as the
# profile patch, and copy the read-only store copy into <DSH_HOME>/sessions.
# The package under test is NOT installed here (see docs/scratch-verification.md).
set -eu
export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"
LABEL=${1:?label}
STORE_SRC=${SSP_STORE_SRC:-/tmp/ssp-scratch-store/sessions}
SH=scripts/scratch-home.mjs
ROOT=$(node "$SH" create --label "s8-$LABEL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).root))')
DSH_HOME_DIR="$ROOT/home/.dsh"
PROFILE="$DSH_HOME_DIR/profiles/web"
node "$SH" check "$DSH_HOME_DIR" >&2
node "$SH" dsh "$ROOT" -- --profile web --dump-config > "$ROOT/work/dump-baseline-web.txt" 2> "$ROOT/work/dump-baseline-web.stderr.txt"
node -e 'const fs=require("fs"),p=process.argv[1]+"/package.json";const m=JSON.parse(fs.readFileSync(p,"utf8"));if(!m.dsh.profile.bundles.includes("@deepseek-ai/dsh-experimental-session-search"))m.dsh.profile.bundles.push("@deepseek-ai/dsh-experimental-session-search");fs.writeFileSync(p,JSON.stringify(m,null,2)+"\n")' "$PROFILE"
cp test/scratch/observers.yml "$PROFILE/cordis.patch.yml"
# Gate: the store destination must be inside this scratch root.
case "$DSH_HOME_DIR/sessions" in
  "$ROOT"/*) ;;
  *) echo "refusing: store destination outside the scratch root" >&2; exit 2 ;;
esac
test ! -e "$DSH_HOME_DIR/sessions"
cp -Rp "$STORE_SRC" "$DSH_HOME_DIR/sessions"
echo "$ROOT"
