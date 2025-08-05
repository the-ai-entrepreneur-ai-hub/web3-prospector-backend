# Web3 Scraper Fix Plan for Priority Sources

## 🎯 Current Issues
1. **Selector Mismatches**: Websites changed structure, existing selectors don't match
2. **Timeout Errors**: 60s timeout insufficient for some sites
3. **Proxy Issues**: Reference errors and connection problems
4. **API Changes**: CoinMarketCap's script#__NEXT_DATA__ structure changed

## 🛠️ Fix Strategy for Each Source

### 1. DappRadar (src/scrapers/dappradar.js)
**Reference Structure**: `sources-webiste-structure/dappradar-structure.json`
**Key Fixes**:
```javascript
// Increase timeout to 120s
const NAVIGATION_TIMEOUT = 120000;

// Update category URLs based on reference structure
const CATEGORIES = [
  { id: 'defi', url: 'https://dappradar.com/rankings/category/defi/1' },
  { id: 'games', url: 'https://dappradar.com/rankings/category/games/1' },
  // ... other categories
];

// Fix dApp card selector (reference shows .dapp-list-item)
await page.waitForSelector('.dapp-list-item', { timeout: NAVIGATION_TIMEOUT });

// Extract data using reference structure
const dapps = await page.$$eval('.dapp-list-item', (items) => 
  items.map(item => ({
    name: item.querySelector('.dapp-name').innerText,
    url: item.querySelector('.dapp-link').href,
    // ... other fields
  }))
);