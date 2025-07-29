const { scrapeCryptoRank } = require('./cryptorank');
const { scrapeCoinMarketCap } = require('./coinmarketcap');
const { scrapeDappRadar } = require('./dappradar');
const { scrapeICODrops } = require('./icodrops');
const { scrapeZealy } = require('./zealy');
const { scrapeDAOMaker } = require('./daomaker');
const { scrapePolkastarter } = require('./polkastarter');
const fs = require('fs');
const path = require('path');

/**
 * Run all scrapers and return a combined list of leads.
 *
 * Each scraper returns an array of leads. This function runs them
 * sequentially to avoid overloading the target websites. If you wish to
 * run them concurrently, use Promise.all but be mindful of the number of
 * outgoing requests and rate limits.
 *
 * @returns {Promise<Array<Object>>} Combined list of leads.
 */
async function runAllScrapers() {
  const all = [];
  const outputDir = path.join(__dirname, '..', '..', 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const scrapers = [
    { name: 'CryptoRank', func: scrapeCryptoRank },
    { name: 'CoinMarketCap', func: scrapeCoinMarketCap },
    { name: 'DappRadar', func: scrapeDappRadar },
    { name: 'ICODrops', func: scrapeICODrops },
    { name: 'Zealy', func: scrapeZealy },
    { name: 'DAOMaker', func: scrapeDAOMaker },
    { name: 'Polkastarter', func: scrapePolkastarter }
  ];

  for (const scraper of scrapers) {
    try {
      console.log(`Running ${scraper.name} scraper...`);
      const results = await scraper.func();
      all.push(...results);
      const outputFile = path.join(outputDir, `${scraper.name}.json`);
      fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
      console.log(`Results from ${scraper.name} saved to ${outputFile}`);
    } catch (error) {
      console.error(`Error running ${scraper.name} scraper:`, error);
      console.error(`Failed to save ${scraper.name} results to ${outputFile}`); // Added for debugging
    }
  }
  return all;
}

module.exports = {
  scrapeCryptoRank,
  scrapeCoinMarketCap,
  scrapeDappRadar,
  scrapeICODrops,
  scrapeZealy,
  scrapeDAOMaker,
  scrapePolkastarter,
  runAllScrapers
};