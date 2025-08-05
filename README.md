# Web3 Prospector Backend

Automated Web3 lead discovery and contact enrichment backend with scrapers, OSINT fallbacks, Snov.io enrichment, and Airtable persistence.

## Overview

This service discovers new Web3 projects from multiple sources (CoinMarketCap, CryptoRank, DappRadar, ICODrops, Zealy, DAO Maker, Polkastarter), deduplicates them by domain, enriches contact details using a layered strategy (website parsing, social OSINT, LinkedIn-guided Snov.io), and upserts results into Airtable. It exposes a small HTTP API for on-demand ingestion and lead lookup, and a scheduler for periodic ingestion.

Core pipeline:
1) Scrape sources and normalize results.
2) Deduplicate projects by domain.
3) Enrich contacts via social fallback and Snov.io.
4) Persist to Airtable and log detailed stats.

## Repository structure

- web3-prospector-backend/
  - .env (example with local dev keys)
  - package.json
  - src/
    - server.js — Express API server
    - scheduler.js — Cron-based scheduler
    - ingest.js — Orchestrates the full pipeline
    - config/
      - selectors.json — Selectors used by Playwright helper
    - scrapers/
      - index.js — Runs all scrapers and writes per-source JSON to ./output
      - coinmarketcap.js — CoinMarketCap "new" listings scraper
      - cryptorank.js — CryptoRank ICOs/sales scraper
      - dappradar.js, icodrops.js, zealy.js, daomaker.js, polkastarter.js — Additional sources
      - sources-webiste-structure/ — Source mapping and structure captures
    - enrichment/
      - snovio.js — Snov.io domain/person enrichment with retry/polling and stats
    - services/
      - airtable.js — Airtable find/upsert helpers
    - utils/
      - logger.js — Structured logging, progress bars, API/proxy log
      - dedup.js — Domain normalization and deduplication
      - social-fallback.js — Website/social scraping, LinkedIn-based enrichment
      - proxy.js — Rotating proxy support and health tracking
      - playwright-helper.js — Playwright helper (stealth, selectors, retries)
      - filters.js — Lead filtering utilities
      - social-fallback.js — Social OSINT fallback chain
      - proxy.js — DataImpulse proxy rotation
    - osint/
      - emailDiscovery.js — Playwright-based OSINT discovery (Twitter/Telegram/WHOIS/DNS/MX)
      - emailDiscovery-windows.js — Windows variant
  - output/
    - CoinMarketCap.json, CryptoRank.json, DappRadar.json, ICODrops.json, Zealy.json
    - enriched/
      - all_enriched.json, CoinMarketCap_enriched.json, ...
  - scripts/tests:
    - enrich-airtable-leads.js, enrich-existing-leads.js
    - test-osint-*.js — quick experiments

## Runtime components

- API server: Starts an Express app exposing:
  - POST /api/v1/leads/start-ingestion — triggers a pipeline run asynchronously
  - GET /api/v1/leads/:domain — returns a record by domain from Airtable
  - GET /api/v1/health — basic liveness probe

- Scheduler: Two cron jobs (daily and weekly) invoke the same ingestion pipeline with configurable cron expressions.

- Ingest pipeline:
  - Scrapers: runAllScrapers() collects recent projects across sources and writes per-source JSON into ./output.
  - Deduplication: dedupLeads() normalizes by domain and merges partial data.
  - Enrichment: social-fallback first tries website/social extraction, then Snov.io domain search with prospect iteration and verified email selection.
  - Storage: upsertLeads() writes to Airtable, mapping fields to your table schema.

## Getting started

Prerequisites:
- Node.js 18+
- Installed browsers for Playwright/Puppeteer (Playwright helper uses playwright)
- Airtable base with a Leads table (or configured table name)
- Snov.io API credentials (Client ID/Secret)
- Optional DataImpulse proxy (or your own proxies) to reduce blocking
- Windows, macOS, or Linux. Some OSINT features use whois (optional).

1) Install dependencies

npm install

2) Configure environment

Copy the provided .env file and replace with your values:
- AIRTABLE_API_KEY — Airtable Personal Access Token
- AIRTABLE_BASE_ID — Airtable Base ID
- AIRTABLE_TABLE_NAME — Table name (default "Leads")
- SNOVIO_CLIENT_ID, SNOVIO_CLIENT_SECRET — Snov.io OAuth client creds
- Optional:
  - OPENAI_API_KEY — reserved for summaries (not implemented)
  - INGEST_CRON_DAILY, INGEST_CRON_WEEKLY — cron schedules
  - PROXY_HOST, PROXY_PORT, PROXY_USERNAME, PROXY_PASSWORD — proxy override

Security note: The committed .env contains placeholder keys. Do not commit real secrets. Use your own secrets via a local .env and ensure VCS ignores it.

3) Verify Playwright browsers

npx playwright install

4) Run in different modes

- API server

npm start

Starts Express on PORT (default 3000).
Health check:
curl http://localhost:3000/api/v1/health

Trigger ingestion:
curl -X POST http://localhost:3000/api/v1/leads/start-ingestion

Lookup by domain:
curl http://localhost:3000/api/v1/leads/example.com

- One-off ingestion worker

npm run ingest

- Scheduler (cron-driven ingestion)

npm run scheduler

Uses env cron expressions to run daily and weekly jobs.

- OSINT discovery demo

node src/osint/emailDiscovery.js

This file includes a broad OSINT workflow with Playwright for Twitter/Telegram/website. It’s not directly wired into the ingestion flow but demonstrates alternative approaches.

## Environment variables

See the sample at web3-prospector-backend/.env. Key variables:

- AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME
  Required for Airtable persistence. If missing, the pipeline will log warnings and skip writes.

- SNOVIO_CLIENT_ID, SNOVIO_CLIENT_SECRET
  Required for enrichment. The module caches tokens and handles polling and rate-limits.

- PROXY_HOST, PROXY_PORT, PROXY_USERNAME, PROXY_PASSWORD
  Optional overrides for rotating proxies. Default is configured for DataImpulse. Replace with your own provider or disable proxy usage by adapting utils/proxy.js and scrapers.

- INGEST_CRON_DAILY, INGEST_CRON_WEEKLY
  Cron syntax, e.g. "0 2 * * *" for daily 2 AM.

- DEBUG=true
  Enables verbose debug logging from the logger utility.

## Data flow

1) Scrape
- src/scrapers/index.js orchestrates per-source scrapers.
- Each scraper writes JSON into ./output/Name.json.
- Results are arrays with at least project_name, website, details_url, source, and domain if available.

2) Deduplicate
- src/utils/dedup.js normalizes domains and merges fields across duplicates to preserve most complete record.

3) Enrich
- Social fallback: src/utils/social-fallback.js uses Puppeteer + proxy rotator to:
  - Extract social links and LinkedIn profiles from the project website
  - Attempt LinkedIn-based Snov.io lookups
  - Crawl pages/contact routes for direct emails
- Snov.io: src/enrichment/snovio.js performs:
  - Domain search start + poll
  - Prospects search start + poll
  - Prospect email search start + poll
  - Selects verified email when available
  - Tracks stats and handles 429 with a single retry

4) Persist
- src/services/airtable.js uses findRecordByDomain() and upsertLead()/upsertLeads() to write to Airtable.
- Field mapping is simple; adjust to your Airtable schema (see notes below).

5) Logging and metrics
- src/utils/logger.js adds timestamps, levels, color, progress bars, API and proxy logs
- Ingest logs a summary of scraped, deduped, enriched, stored, and errors, plus Snov.io stats.

## API reference

- POST /api/v1/leads/start-ingestion
  Triggers a single run of the ingestion pipeline asynchronously. Returns: { status: "started" }

- GET /api/v1/leads/:domain
  Looks up a record in Airtable by domain. Returns 404 if not found.

- GET /api/v1/health
  Basic liveness payload: { status: "ok", time: ISO8601 }

## Scheduler

The scheduler runs the same ingest() function on two cron schedules:
- INGEST_CRON_DAILY (default 0 2 * * *)
- INGEST_CRON_WEEKLY (default 0 3 * * 1)

Start with:
npm run scheduler

Logs the current schedules and keeps the process alive.

## Output artifacts

- Per-source JSON dumps in ./output for auditability and debugging:
  - CoinMarketCap.json, CryptoRank.json, DappRadar.json, ICODrops.json, Zealy.json
- Enriched outputs optionally stored under ./output/enriched for later review.

## Airtable schema

Default mapping in src/services/airtable.js:
- "Project Name"  <- lead.name
- "Website"       <- lead.website
- "Status"        <- lead.status (default "New Lead")
- "Source"        <- lead.source (e.g., "ICODrops", "CryptoRank", etc.)
- "Twitter"       <- lead.twitter
- "LinkedIn"      <- lead.linkedin
- "Email"         <- lead.email (optional)
- "Telegram"      <- lead.telegram (optional)
- "Date Added"    <- today’s date

Adjust these to match your Airtable column names. If your base uses different field names, update the fields object inside upsertLead().

## Proxies

The proxy layer (utils/proxy.js) is wired into Playwright/Puppeteer and axios. It:
- Rotates through multiple session endpoints
- Tracks per-proxy health, errors, and response times
- Integrates with logger for visibility

Replace the default provider credentials with your own via environment variables, or adapt the file to your proxy provider.

## Development and troubleshooting

- Enable debug logging

Set DEBUG=true in your .env to get fine-grained logs from logger.js, including API and proxy rotation traces.

- Playwright setup

If you see errors related to missing browsers:
npx playwright install

- Rate limits

Snov.io enrichment has basic backoff on HTTP 429 with a single retry. For heavy workloads, add queues and longer backoffs.

- Website changes

Scrapers rely on DOM structure and Next.js __NEXT_DATA__ payloads. If sources change, update selectors in scrapers or centralize in src/config/selectors.json and the Playwright helper.

- Windows whois

emailDiscovery.js uses shell whois, which may not exist on Windows by default. Either install a whois client or skip the WHOIS step.

- Airtable disabled

If AIRTABLE_API_KEY or base ID is missing, Airtable functions no-op with warnings, allowing you to test scraping/enrichment without writing.

## Scripts

From package.json:
- start: node src/server.js
- ingest/worker: node src/ingest.js
- scheduler: node src/scheduler.js

Additional scripts/utilities are provided in the root for experimentation (test-osint-*.js, enrich-*.js).

## Security notes

- Never commit real API keys. The included .env is an example; replace with your own secrets locally and ensure VCS ignores the file.
- Proxies and enrichment services incur cost and risk—ensure you comply with target sites’ terms and applicable laws.
- Respect robots.txt and rate limits; scrapers are tuned with waits and retries to reduce load.

## Roadmap highlights

- Add AI summaries and competitor analysis (placeholders exist in ingest.js).
- Centralize all selectors and site-specific parsing logic in config/selectors.json.
- Batch Airtable upserts to reduce API calls.
- Add end-to-end tests for scrapers with snapshot fixtures.
- Expand social-fallback to first/last name extraction across multiple pages and languages.

## License

Proprietary. All rights reserved.