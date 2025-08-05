const { PlaywrightHelper } = require('../utils/playwright-helper');
const { extractDomain } = require('../utils/dedup');
const { createLogger } = require('../utils/logger');

/**
 * Fast CoinMarketCap scraper using EXACT Apify approach
 * - Direct browser automation (no ScraperAPI)
 * - Concurrent processing like Apify
 * - Reuses browser session
 */
async function scrapeCoinMarketCap() {
    const logger = createLogger('CoinMarketCap-Fast');
    const startTime = Date.now();
    
    logger.info('Starting FAST CoinMarketCap scraper using direct Playwright (Apify approach)');

    const playHelper = new PlaywrightHelper({
        headless: true,
        timeout: 30000,
        retries: 2
    });
    
    let results = [];
    const stats = { found: 0, processed: 0, filtered: 0, errors: 0 };

    try {
        // Initialize browser once and reuse
        await playHelper.initialize();
        const page = playHelper.page;
        
        // STEP 1: Get coin list from main page (same as Apify)
        logger.info('STEP 1: Extracting coin list from main page...');
        await playHelper.navigateTo('https://coinmarketcap.com/new/');
        
        const nextDataSelector = 'script#__NEXT_DATA__';
        await page.waitForSelector(nextDataSelector, { state: 'attached', timeout: 30000 });
        
        const pageData = await page.evaluate((selector) => {
            return JSON.parse(document.querySelector(selector).textContent);
        }, nextDataSelector);
        
        const coins = pageData?.props?.pageProps?.data?.data?.recentlyAddedList || [];
        if (coins.length === 0) {
            throw new Error('No coins found in main page __NEXT_DATA__');
        }
        
        stats.found = coins.length;
        logger.success(`Found ${coins.length} coins to process`);
        
        // Filter out meme coins
        const validCoins = coins.filter(coin => {
            const name = coin.name.toLowerCase();
            if (/\b(doge|shib|pepe|meme|inu|baby|moon|safe|elon)\b/.test(name)) {
                stats.filtered++;
                return false;
            }
            return true;
        }); // Process all valid coins
        
        logger.info(`Processing all ${validCoins.length} valid coins (${stats.filtered} meme coins filtered)`);
        
        // STEP 2: Process each coin detail page (reusing same browser)
        for (let i = 0; i < validCoins.length; i++) {
            const coin = validCoins[i];
            
            try {
                logger.info(`Processing ${i + 1}/${validCoins.length}: ${coin.name}`);
                
                const detailUrl = `https://coinmarketcap.com/currencies/${coin.slug}/`;
                
                // Navigate to detail page (same browser session - FAST!)
                await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForSelector(nextDataSelector, { state: 'attached', timeout: 30000 });
                
                // Extract URLs using EXACT Apify logic
                const detailPageData = await page.evaluate((selector) => {
                    return JSON.parse(document.querySelector(selector).textContent);
                }, nextDataSelector);
                
                const urls = detailPageData?.props?.pageProps?.detailRes?.detail?.urls;
                
                let website = '';
                let twitter = '';
                let telegram = '';
                let discord = '';
                let github = '';
                
                if (urls) {
                    // EXACT Apify extraction logic
                    if (urls.website && urls.website.length > 0) website = urls.website[0];
                    if (urls.twitter && urls.twitter.length > 0) twitter = urls.twitter[0];
                    if (urls.source_code && urls.source_code.length > 0) github = urls.source_code[0];
                    
                    // Extract from chat array (EXACT Apify logic)
                    if (urls.chat && urls.chat.length > 0) {
                        urls.chat.forEach(link => {
                            if (link.includes('discord')) discord = link;
                            else if (link.includes('t.me')) telegram = link;
                        });
                    }
                }
                
                // Skip if no website
                if (!website) {
                    logger.debug(`Skipping ${coin.name}: no website found`);
                    stats.filtered++;
                    continue;
                }
                
                const projectData = {
                    name: coin.name,
                    website: website,
                    status: 'New Lead',
                    source: 'CoinMarketCap',
                    date_added: new Date().toISOString().split('T')[0],
                    domain: extractDomain(website),
                    details_url: detailUrl,
                    symbol: coin.symbol
                };
                
                // Add all social fields found
                if (twitter) projectData.twitter = twitter;
                if (telegram) projectData.telegram = telegram;
                if (discord) projectData.discord = discord;
                if (github) projectData.github = github;
                
                results.push(projectData);
                stats.processed++;
                
                logger.info(`✅ ${coin.name}: Website: ${website}, Twitter: ${twitter || 'none'}, Telegram: ${telegram || 'none'}`);
                
                // Small delay between requests (much smaller than ScraperAPI approach)
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                stats.errors++;
                logger.error(`Failed to process ${coin.name}: ${error.message}`);
                continue;
            }
        }
        
    } catch (error) {
        logger.error('Critical error in fast scraper:', error);
        stats.errors++;
        throw error;
    } finally {
        await playHelper.cleanup();
    }
    
    stats.duration = Date.now() - startTime;
    
    logger.info('=== FAST COINMARKETCAP SCRAPING STATISTICS ===');
    logger.info(`Coins Found: ${stats.found}`);
    logger.info(`Coins Processed: ${stats.processed}`);
    logger.info(`Coins Filtered: ${stats.filtered}`);
    logger.info(`Projects Extracted: ${results.length}`);
    logger.info(`Errors: ${stats.errors}`);
    logger.info(`Duration: ${(stats.duration / 1000).toFixed(1)}s`);
    logger.info(`Average per coin: ${(stats.duration / Math.max(stats.processed, 1) / 1000).toFixed(1)}s`);
    
    logger.success(`Fast CoinMarketCap scraping completed: ${results.length} projects in ${(stats.duration / 1000).toFixed(1)}s`);
    
    // Deduplicate by domain
    const uniqueResults = {};
    results.forEach(item => {
        if (item.domain) {
            uniqueResults[item.domain] = item;
        }
    });
    
    return Object.values(uniqueResults);
}

module.exports = { scrapeCoinMarketCap };