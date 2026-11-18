#!/bin/sh
# S1 spike: rebuild the chosen-patch composition on a FRESH scratch DSH home and
# check it. Every dsh call goes through scripts/scratch-home.mjs; nothing reads
# or writes the real ~/.dsh. Run from packages/session-search-patched:
#   sh docs/spike/reproduce-chosen-dump.sh
# The scratch root stays for inspection; remove it with
#   node scripts/scratch-home.mjs destroy <root>
set -eu
export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"
SH=scripts/scratch-home.mjs
ELECTRON="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ROOT=$(node "$SH" create --label s1-reproduce | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).root))')
echo "scratch root: $ROOT"
PROFILE="$ROOT/home/.dsh/profiles/web"
OUT="$ROOT/work"

# 1. Initialize the scratch web profile (the dump creates it from the shipped template).
node "$SH" dsh "$ROOT" -- --profile web --dump-config > "$OUT/dump-baseline-web.txt"
# 2. Select the optional session-search bundle, as the plugin manager's bundle switch does
#    (it appends the name to dsh.profile.bundles); no CLI command selects an installation bundle.
node -e 'const fs=require("fs"),p=process.argv[1]+"/package.json";const m=JSON.parse(fs.readFileSync(p,"utf8"));m.dsh.profile.bundles.push("@deepseek-ai/dsh-experimental-session-search");fs.writeFileSync(p,JSON.stringify(m,null,2)+"\n")' "$PROFILE"
node "$SH" dsh "$ROOT" -- --profile web --dump-config > "$OUT/dump-baseline-search.txt"
# 3. Link-install the probe bundle, which carries the chosen patch as its cordis.patch.yml.
node "$SH" dsh "$ROOT" -- plugin --profile web add "$PWD/docs/spike/probe" > "$OUT/install.txt" 2>&1
# 4. The recorded dump command, then the checks.
node "$SH" dsh "$ROOT" -- --profile web --dump-config > "$OUT/dump-chosen.txt"
node "$SH" run "$ROOT" --cwd "$PWD" --set ELECTRON_RUN_AS_NODE=1 -- "$ELECTRON" docs/spike/analyze-dump.cjs \
  "$OUT/dump-baseline-search.txt" "$OUT/dump-chosen.txt"
shasum -a 256 docs/spike/probe/cordis.patch.yml
