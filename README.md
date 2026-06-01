# PEER.AS

**A static, reproducible explorer for the global IPv4 BGP table** — every prefix,
its origin ASNs, and the actual **AS_PATH**s that reach it. The whole thing runs in
your browser: there is no backend, no API, and no database server. The site is just
a bundle of static files you can host, fork, or mirror anywhere.

Live at **[peer.as](https://peer.as)**.

It's a looking-glass-style reference for the routing table, delivered as a
self-hostable static artifact rather than a hosted service.

---

## The idea: the AS_PATH is the signal

PEER.AS is built on one opinion about public BGP data: **the part worth reading is
the AS_PATH** — *which* ASNs carry a prefix, and in *what order*. Everything follows
from that, and it deliberately avoids claims the data can't support:

- **Order and adjacency matter.** Searching `23764 4809` means those two ASNs appear
  **consecutively** in the path — a different question from "the path contains both
  somewhere." `1299 23764 4809` and `1299 4809` are genuinely different routes.
- **No line-quality scoring.** A public collector can't distinguish premium from
  standard transit (they often share an AS), so PEER.AS shows the path and does not
  grade it.
- **Origin AS is display-only.** It labels a prefix; it never drives ranking or
  filtering.
- **Multihoming falls out for free.** A collector's RIB is *per-peer*, so the set of
  distinct paths to a prefix is its observed multihome / equal-cost routing, straight
  from the data — nothing inferred.

## What you can do

- **Search by AS_PATH** — type a sequence of ASNs and find every prefix whose path
  contains that **consecutive** run. Supports wildcards (`*` any gap, `?` one hop)
  and exclusion (`!N` = path must *not* contain ASN N). Works globally or scoped to a
  country.
- **Search by origin AS** — exact lookup of everything a given network originates.
- **IP / CIDR lookup** — enter an address or prefix and get every covering and
  more-specific prefix in the table, most-specific first.
- **Per-prefix insight** — open any prefix for a **route graph** (origin → upstreams
  → Tier-1) drawn from all observed paths, the **best path** highlighted, and its
  **parent / child prefixes** found live by numeric range.
- **Browse by country & city** — prefixes are resolved against a geo database and
  grouped into the regions they cover (city level where available).
- **Bilingual (中文 / English)** UI, pre-rendered per-country landing pages, a
  sitemap, and `?lang` / `?cc` / `?city` deep links.
- **Smart search box** — one field auto-detects IP / CIDR / ASN / network-name input.

## Static & reproducible

The dataset is exported to **Parquet** and queried in-browser with **DuckDB-WASM**,
directly against the static files. There is no query server.

How a query stays cheap: `meta.json` carries compact **interval indexes** (by
country, by origin ASN, by prefix id), so the browser loads only the **few Parquet
shards a query actually needs** rather than the whole dataset. A country or origin-AS
lookup typically pulls a few MB out of the ~560 MB dataset; a prefix's detail view
reads one path shard. Pruning is at the **shard** level — DuckDB-WASM fetches each
needed shard in full (the files are sized small enough that whole-file downloads beat
many small range requests). The one heavy case is an **AS_PATH search with no origin
filter**, which has nothing to prune on and scans all path shards.

That design buys:

- **Serverless & cheap** — deploys to any static host; no compute, no per-query cost.
- **Reproducible** — data comes from a public source (RIPE RIS `rrc00` MRT dumps);
  anyone can re-run the pipeline and rebuild the same site.
- **Self-hostable & mirrorable** — it's just files, so you can clone it for archival,
  offline use, or running your own snapshot.

## How it's built

```
RIPE rrc00 MRT RIB ──ingest──► SQLite (full IPv4 table, distinct per-peer paths)
                                  │
                                  └─export-parquet──► Parquet shards + meta.json
                                                       (geo/<cc>, prefixes, paths,
                                                        pathsearch) + bilingual SSG
                                                          │
                                          DuckDB-WASM (browser) ──fetch needed shards──► you
```

- **Collector** — a streaming MRT parser ingests the latest `rrc00` RIB and stores
  every IPv4 prefix with its distinct AS_PATHs. Nothing is filtered out at ingest.
- **Export** — SQLite is exported to a Parquet dataset, each table sorted by its
  access key (prefixes by `ip_start`, paths by prefix id, pathsearch by origin ASN)
  and split into ~25 MiB shards, with interval indexes in `meta.json` so the frontend
  fetches only the relevant shards. A static-site generator emits per-country pages.
- **Frontend** — a Vite + Svelte 5 app running DuckDB-WASM against the Parquet files.

**Scale** (per daily `rrc00` snapshot): **~1.13 M** IPv4 prefixes, **~47.5 M**
distinct AS_PATHs, ~1.34 M path segments, 242 countries — ~3.0 GB SQLite exported to
**~560 MB** Parquet. IPv6 is deferred for now.

### Geolocation: dual-track

Two interchangeable geo backends, so the project stays fully open while the hosted
site can be more precise:

- **`rir`** — RIR delegated-extended stats: country-level, openly redistributable,
  fully reproducible for anyone rebuilding from scratch.
- **`ipdb`** — a city-level commercial database used by the hosted deployment; the
  file itself is private and **not** redistributable.

## Limitations (worth knowing)

- AS_PATHs are the *outbound* view of whichever peers `rrc00` has; a given network's
  true vantage is only as complete as that collector. "Path contains ASN X" is the
  most robust filter (peer-independent); strict ordering depends on the collector's
  view.
- Parent / child segments are computed over **collected** prefixes — a large slice of
  the table, not a private global RIB — so coverage can be partial (the UI says so).
- City-level geolocation is only as good as the underlying geo database.
- An AS_PATH search without an origin filter scans every path shard (~hundreds of MB
  downloaded); scope it by country or origin AS when you can.
- This is a research / education tool over a public, approximate snapshot. It can be
  stale and is **not authoritative for operational decisions**.

## Deploy your own

> 💡 **Fast path — let your agent do it.** This repo is maintained end-to-end by an AI
> coding agent, and **[`AGENTS.md`](AGENTS.md)** is the authoritative, always-current
> runbook (exact build steps, Cloudflare Pages / R2 specifics, gotchas, invariants).
> Open the repo in a coding agent (e.g. Claude Code) and ask it to *"deploy following
> AGENTS.md"* — it will build and push for you. The steps below are the same process
> by hand.

The pipeline is a self-contained CLI (`ipc`).

**1. Build the dataset and site**

```bash
pip install -r requirements.txt              # Python deps (DuckDB, MRT parser, …)
./ipc geo-import --provider rir              # open country-level geo (or `ipdb` if you have a city DB)
./ipc ingest --reset                         # download & parse the latest rrc00 RIB (~400 MB → SQLite ~3 GB)
( cd ipcollect/web && npm ci && npm run build )   # build the Svelte frontend
./ipc export-parquet --out dist              # SQLite → Parquet + meta.json + bilingual SSG, into dist/
```

`dist/` is now a complete static site (frontend + `dist/data/` Parquet + per-country
SEO pages).

**2a. Host it anywhere (simplest)**

```bash
./ipc serve --port 8812                      # local preview of the same artifact
```

Upload `dist/` to any static host (Cloudflare Pages, Netlify, S3, nginx…). Data is
served same-origin from `dist/data/`. That's it.

**2b. Frontend + object-storage split (what peer.as runs)**

A ~0.5 GB dataset can exceed a static host's per-file or total limits, and
re-uploading it on every refresh is wasteful. The hosted site keeps the **frontend on
Cloudflare Pages** and the **Parquet data on Cloudflare R2** (free egress, no
file-size cap), selected by one build-time env var (`VITE_DATA_BASE`):

```bash
# one-time: bucket + public custom domain + CORS (allow GET/HEAD from your site origin)
wrangler r2 bucket create "$R2_BUCKET"
wrangler r2 bucket domain add "$R2_BUCKET" --domain data.example.com --zone-id <zone-id>
wrangler r2 bucket cors set "$R2_BUCKET" --file cors.json

# build the frontend pointing data at the bucket, then deploy the frontend to Pages
echo 'VITE_DATA_BASE=https://data.example.com' >> .env    # gitignored
( cd ipcollect/web && npm run build )
./ipc export-parquet --out dist
# upload dist/data/* to the bucket (data first, meta.json last), then:
wrangler pages deploy dist --project-name <your-project>
```

Leave `VITE_DATA_BASE` empty to fall back to same-origin `dist/data/`. The exact CORS
JSON, the upload loop, and the caching/version invariants are in **[`AGENTS.md`](AGENTS.md)**.

**3. Keep it fresh (optional)**

`scripts/daily-refresh.sh` chains ingest → export → R2 sync → Pages deploy; run it
from cron (the hosted site refreshes daily). Details in `AGENTS.md`.

Configuration lives in `config.json` (gitignored; template in `config.example.json`).
Secrets — Cloudflare credentials, the private geo path, `VITE_DATA_BASE`, `R2_BUCKET`
— go in `.env` (template `.env.example`) and are never committed.

## Sponsors

Servers and infrastructure for the hosted **[peer.as](https://peer.as)** deployment
are generously **sponsored by [DMIT](https://www.dmit.io)**.

[![DMIT](ipcollect/web/public/dmit.svg)](https://www.dmit.io)

## Project notes

- **Data source:** [RIPE RIS](https://ris.ripe.net/) `rrc00` public MRT RIB dumps.
- **Changelog:** user-facing changes in **[`CHANGELOG.md`](CHANGELOG.md)** (also in-app).
- **Maintenance & deployment:** **[`AGENTS.md`](AGENTS.md)** is the authoritative
  runbook; the data/format contract is in **`docs/GLOBAL_DESIGN.md`**.
- For BGP research and education only.
