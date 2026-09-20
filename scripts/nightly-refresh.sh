#!/bin/sh
# nightly: crawl data -> page universe (order matters; universe reads crawl_pages)
cd /Users/aloke.sharma/seo-copilot
/usr/local/bin/node scripts/crawl-ingest.mjs
/usr/local/bin/node scripts/universe-build.mjs
