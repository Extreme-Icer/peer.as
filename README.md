# PEER.AS

**A pure-static, reproducible BGP / IP / ASN insights hub.** Explore the global
IPv4 routing table — prefixes, origin ASNs, and the actual **AS_PATH**s that reach
them — entirely in your browser. No backend, no API, no database server: the whole
site is a bundle of static files you can host, fork, or mirror anywhere.

Live at **[peer.as](https://peer.as)**.

PEER.AS sits somewhere between [ipinfo](https://ipinfo.io),
[bgp.he.net](https://bgp.he.net), and [bgp.tools](https://bgp.tools) — a looking
glass and IP/ASN reference — but built on a single conviction about what BGP data
is actually good for, and delivered as a static artifact rather than a service.

---

## The idea

Most "BGP route quality" tooling tries to read meaning into a path that isn't
there. PEER.AS deliberately does the opposite. **The only thing worth reading out
of a public BGP feed is the AS_PATH** — *which* ASNs carry a prefix and in *what
order*. Everything is built around that:

- **Order and adjacency matter.** Searching for `23764 4809` means those two ASNs
  appear **consecutively** in the path — which is a different question from "the
  path contains both 23764 and 4809 somewhere." `1299 23764 4809` and
  `1299 4809` are genuinely different routes.
- **No line-quality scoring, ever.** You cannot tell premium transit tiers apart
  from a public collector's view (e.g. a carrier's premium and standard products
  often share the same AS), so PEER.AS doesn't pretend to. It shows the path; it
  doesn't grade it.
- **`origin AS` is display-only.** It labels a prefix; it never drives ranking or
  filtering.
- **Multihoming falls out for free.** A collector's RIB is *per-peer* — each peer
  contributes one path *toward* a destination — so the set of distinct paths to a
  prefix is its observed multihome / equal-cost routing, straight from the data.

## Why static & reproducible

The entire dataset is exported to **Parquet** and queried in-browser with
**DuckDB-WASM** over **HTTP Range** requests. There is no server doing queries —
the browser fetches only the byte ranges of the Parquet files it needs.

That design buys three things:

- **Serverless & cheap.** It deploys to any static host (Cloudflare Pages today).
  No compute, no scaling, no per-query cost.
- **Reproducible.** The data comes from a public source (RIPE RIS `rrc00` MRT
  dumps). Anyone can re-run the pipeline and rebuild the exact same site.
- **Mirrorable.** Because it's just files, you can clone and self-host the whole
  thing — useful for archival, censorship resistance, or running your own snapshot.

## What you can do

- **Search by AS_PATH** — type a sequence of ASNs and find every prefix whose path
  contains that **consecutive** run. Works globally (full-table scan) or scoped to
  a country.
- **Search by origin AS** — exact, fast, column-pruned lookup of everything a given
  network originates.
- **Subnet / IP lookup** — enter an IP and get every prefix in the table that
  covers it, most-specific first.
- **Per-prefix insight** — open any prefix to see a **route graph** (origin →
  upstreams → Tier-1) drawn from all observed paths, the **best path** highlighted,
  and its **parent / child prefixes** (covering and more-specific routes found live
  by numeric range).
- **Browse by country & city** — geolocation is resolved against a geo database,
  and prefixes are carved into the regions they actually cover.
- **Bilingual (中文 / English)** UI with pre-rendered, SEO-friendly per-country
  landing pages, a sitemap, and `?lang` / `?cc` / `?city` deep links.

## How it's built

```
RIPE rrc00 MRT RIB ──ingest──► SQLite (full IPv4 table, deduped per-peer paths)
                                  │
                                  └─export-parquet──► Parquet dataset + meta.json
                                                       (geo/<cc>, prefixes, paths,
                                                        pathsearch) + bilingual SSG
                                                          │
                                          DuckDB-WASM (browser) ──HTTP Range──► you
```

- **Collector** — a streaming MRT parser ingests the latest `rrc00` RIB and stores
  every IPv4 prefix with its distinct AS_PATHs (`ingest_scope=global`; nothing is
  filtered out at ingest).
- **Export** — the SQLite database is exported to a Parquet dataset, sorted and
  partitioned so that DuckDB-WASM can prune to a handful of byte ranges per query.
  A static-site generator emits per-country landing pages for crawlers.
- **Frontend** — a Vite + Svelte 5 app (dark "console" aesthetic, system fonts,
  Font Awesome icons) that runs DuckDB-WASM against the remote Parquet files.

**Scale** (2026-05 `rrc00` snapshot): ~1.13M IPv4 prefixes, ~47.5M distinct paths,
≈3.0 GB SQLite, ≈460 MB Parquet. IPv6 is deferred for now.

### Geolocation: dual-track

PEER.AS supports two interchangeable geo backends so the project stays open while
the hosted site can be more precise:

- **`ipdb`** — a city-level commercial database (used by the official deployment;
  the file itself is private and **not** redistributable).
- **`rir`** — RIR delegated-extended stats: country-level, openly redistributable,
  fully reproducible for anyone rebuilding from scratch.

## Limitations (worth knowing)

- AS_PATHs are approximated from the *outbound* view of each public collector peer;
  a specific network's true vantage point is limited to whichever peers `rrc00`
  has. "Path contains ASN X" is the most robust filter (peer-independent); strict
  ordering/adjacency depends on the collector's view.
- Parent/child segments are computed only over **collected** prefixes — this is a
  large slice of the table, not a private global RIB, so coverage can be partial
  (the UI says so).
- City-level geolocation is only as good as the underlying geo database.
- This is a research/education tool over a public, approximate snapshot — it can be
  stale, and it is not authoritative for operational decisions.

## Running it yourself

The pipeline is a self-contained CLI (`ipc`). In short:

```bash
./ipc geo-import --provider rir     # open country-level geo (or ipdb if you have it)
./ipc ingest --reset                # download & parse the latest rrc00 RIB (~400 MB)
./ipc export-parquet --out dist     # SQLite → Parquet dataset + bilingual SSG
# dist/ is now a complete static site — deploy it anywhere, or:
./ipc serve --port 8812             # local preview (serves the same artifact)
```

Configuration lives in `config.json` (gitignored; commit-safe template in
`config.example.json`). Secrets — Cloudflare credentials, the private geo path —
are supplied via environment variables (`.env.example`) and never committed.

## Sponsors

Servers and infrastructure for the hosted **[peer.as](https://peer.as)** deployment
are generously **sponsored by [DMIT](https://www.dmit.io)**.

[![DMIT](https://www.dmit.io/templates/dmit_theme_2020/dmit/assets/images/dmit_logo_with_text.svg)](https://www.dmit.io)

## Project notes

- **Data source:** [RIPE RIS](https://ris.ripe.net/) `rrc00` public MRT RIB dumps.
- **Maintenance & deployment** details (build steps, Cloudflare Pages specifics,
  the HTTP-Range/caching gotcha, invariants) live in **[`AGENTS.md`](AGENTS.md)**,
  and the data/format contract in **`docs/GLOBAL_DESIGN.md`**.
- **For BGP research and education only.**
