#!/bin/bash
# Crawl cadence, as agreed:
#   • every second week  → the FULL site crawl (all analyses, incl. near-duplicates)
#   • every other week    → a status-code check of just the ~145 priority pages
#
# launchd cannot express "fortnightly", so this runs weekly and decides. The light
# week exists because a 404 on a page earning thousands of clicks must not sit
# undetected for a fortnight — that was the one risk fortnightly introduced.
set -u
WORK="$HOME/.seo-copilot"
LOG="$WORK/cadence.log"
SF="/Applications/Screaming Frog SEO Spider.app/Contents/MacOS/ScreamingFrogSEOSpiderLauncher"
REPO="$HOME/seo-copilot"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

WEEK=$(date +%V)                       # ISO week number
if [ $((10#$WEEK % 2)) -eq 0 ]; then
  say "week $WEEK (even) — FULL crawl"
  exec "$WORK/sf-daily-crawl.sh"
fi

say "week $WEEK (odd) — priority-page status check only"
LIST="$WORK/tier1-urls.txt"
"$(which node)" -e '
  import("'"$REPO"'/scripts/lib/d1.mjs").then((m) => {
    const rows = m.query("SELECT url FROM page_universe WHERE tier=1 ORDER BY clicks_90 DESC");
    require("fs").writeFileSync("'"$LIST"'", rows.map((r) => r.url).join("\n"));
    console.log(rows.length);
  });' >> "$LOG" 2>&1

N=$(wc -l < "$LIST" | tr -d ' ')
if [ "$N" -lt 10 ]; then say "only $N priority URLs — skipping"; exit 0; fi

OUT="$WORK/exports/$(date +%Y-%m-%d)/status-check"
mkdir -p "$OUT"
"$SF" --crawl-list "$LIST" --headless \
  --config "$WORK/sf-config.seospiderconfig" \
  --output-folder "$OUT" --export-tabs "Internal:All" --export-format csv \
  >> "$LOG" 2>&1
say "status check done for $N pages -> $OUT"

# fold the result into crawl_pages so the technical agents see it
cd "$REPO" && "$(which node)" scripts/crawl-ingest.mjs >> "$LOG" 2>&1
say "ingested"
