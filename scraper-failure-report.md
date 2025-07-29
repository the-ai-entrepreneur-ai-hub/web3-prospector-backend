
# 🛠️ Web3 Prospector Backend - Scraper Failure Report

This report captures the critical failures across all scrapers executed via `npm run worker` on **July 29, 2025**.

---

## 🔧 Setup & Warnings

- **Engine Warnings**:
  - `cheerio@1.1.2` and `undici@7.12.0` require Node `>=20.18.1`, current is `v20.11.1`.
- **Vulnerabilities**: 5 high-severity issues reported by `npm audit`.
- ✅ Despite warnings, installation and startup succeeded.

---

## ❌ CryptoRank Scraper Failures

- **Target URLs**:
  - Upcoming: `https://cryptorank.io/ico?status=upcoming`
  - Active: `https://cryptorank.io/ico?status=active`
  - Token Sales: `https://cryptorank.io/ico`

- **Issue**: Selector mismatch.
  - `None of the selectors found an element: [data-testid='project-card'], .project-card, .ico-item, .project-item`

- **Outcome**:
  - 3 sections attempted
  - ✅ Navigation OK
  - ❌ No data extracted
  - 📉 Success rate: 0.0%

---

## ❌ CoinMarketCap Scraper Failure

- **Target**: `https://coinmarketcap.com/new/`
- **Issue**: Missing Next.js root data.
  - `None of the selectors found an element: script#__NEXT_DATA__`
- **Outcome**:
  - ❌ 0 entries extracted
  - 📉 Success rate: 0.0%

---

## ❌ DappRadar Scraper Failures

- **Target URLs**:
  - DeFi: `https://dappradar.com/rankings/category/defi`
  - Games: `https://dappradar.com/rankings/category/games`
  - Exchanges: `https://dappradar.com/rankings/category/exchanges`
  - Marketplaces: `https://dappradar.com/rankings/category/marketplaces`

- **Issue**: No matching selectors on any category.
  - `None of the selectors found an element: [data-testid='dapp-item'], .sc-AxgMl, .dapp-card, .ranking-item`

- **Outcome**:
  - ❌ 0 dApps extracted across 4 categories
  - 📉 Success rate: 0.0%
  - ⏱️ Runtime: ~245 seconds

---

## ⚠️ ICODrops Scraper

- **Target**: `https://icodrops.com/`
- ✅ Navigation succeeded
- ⚠️ No output recorded
- ❓ Possibly incomplete logging or early termination

---

## ✅ Proxy Health Check

- 5 proxies initialized and healthy
- No errors in connection/rotation
- Stealth mode with Playwright worked

---

## 📦 Summary

| Source         | Success | Projects | Errors | Notes                              |
|----------------|---------|----------|--------|------------------------------------|
| CryptoRank     | ❌      | 0        | 3      | All selectors outdated             |
| CoinMarketCap  | ❌      | 0        | 1      | Missing Next.js root script        |
| DappRadar      | ❌      | 0        | 4      | All selectors failed               |
| ICODrops       | ⚠️      | Unknown  | ?      | No scraping logs after navigation  |

---

## 🔁 Recommendations

- **Revise Selectors**: Use latest site structure for all `.json` configs.
- **Add Fallbacks**: For changed selectors or missing tags.
- **Improve Load Waits**: Account for hydration and JS delays.
- **Crash Proofing**: Ensure scrapers fail gracefully and continue.

