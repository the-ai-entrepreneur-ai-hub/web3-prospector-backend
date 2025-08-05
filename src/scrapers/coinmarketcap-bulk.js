const { createPlaywrightHelper } = require('../utils/playwright-helper');
const { createLogger } = require('../utils/logger');
const { extractDomain } = require('../utils/dedup');

/**
 * OPTIMIZED: Bulk CoinMarketCap scraper - Extract maximum data with minimum page loads
 * 
 * Key Optimizations:
 * 1. Extract all possible data from main listing page
 * 2. Batch process detail pages in parallel
 * 3. Smart caching to avoid redundant requests
 * 4. Fallback strategies for missing data
 */
async function scrapeCoinMarketCapBulk() {
    const logger = createLogger('CoinMarketCap-Bulk');
    const startTime = Date.now();
    
    logger.info('Starting OPTIMIZED CoinMarketCap bulk scraper');
    
    const playHelper = createPlaywrightHelper();
    const nextDataSelector = 'script#__NEXT_DATA__';
    
    const stats = {
        found: 0,
        processed: 0,
        filtered: 0,
        errors: 0,
        bulkExtracted: 0,
        detailPagesNeeded: 0
    };
    
    let results = [];
    
    try {
        // Initialize browser
        const { page } = await playHelper.initialize();
        logger.info('Browser initialized for bulk extraction');
        
        // STEP 1: Enhanced main page data extraction
        logger.info('STEP 1: Bulk extracting data from main listings page...');
        
        await page.goto('https://coinmarketcap.com/new/', { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        });
        
        await page.waitForSelector(nextDataSelector, { state: 'attached', timeout: 30000 });
        
        // Extract comprehensive data from main page
        const mainPageData = await page.evaluate((selector) => {
            const nextData = JSON.parse(document.querySelector(selector).textContent);
            const coinsData = nextData?.props?.pageProps?.cryptoCurrencyMap?.data;
            
            const extractedCoins = [];
            
            if (coinsData) {
                Object.values(coinsData).forEach(coin => {
                    // Enhanced data extraction from main page
                    const coinData = {
                        id: coin.id,
                        name: coin.name,
                        symbol: coin.symbol,
                        slug: coin.slug,
                        // Try to extract social links from main page data
                        urls: coin.urls || {},
                        // Market data available on main page
                        marketCap: coin.quote?.USD?.market_cap,
                        price: coin.quote?.USD?.price,
                        // Basic info
                        dateAdded: coin.date_added,
                        tags: coin.tags || [],
                        // Platform info
                        platform: coin.platform
                    };
                    
                    extractedCoins.push(coinData);
                });
            }
            
            return extractedCoins;
        }, nextDataSelector);
        
        if (!mainPageData || mainPageData.length === 0) {
            throw new Error('No coins found in main page data');
        }
        
        stats.found = mainPageData.length;
        logger.success(`Found ${mainPageData.length} coins in bulk extraction`);
        
        // STEP 2: Filter and process coins
        const validCoins = mainPageData.filter(coin => {
            // Enhanced filtering logic
            if (!coin.name || !coin.slug) return false;
            
            // Filter meme coins by tags and name patterns
            const memeIndicators = ['meme', 'dog', 'cat', 'moon', 'safe', 'baby', 'mini', 'shib', 'doge'];
            const nameLower = coin.name.toLowerCase();
            const hasMemeTag = coin.tags?.some(tag => 
                typeof tag === 'string' && memeIndicators.some(indicator => 
                    tag.toLowerCase().includes(indicator)
                )
            );
            const hasMemeInName = memeIndicators.some(indicator => nameLower.includes(indicator));
            
            if (hasMemeTag || hasMemeInName) {
                stats.filtered++;
                return false;
            }
            
            return true;
        });
        
        logger.info(`Processing ${validCoins.length} valid coins (${stats.filtered} filtered out)`);
        
        // STEP 3: Bulk process with smart batching
        const coinsWithSocials = [];
        const coinsNeedingDetails = [];
        
        // First pass: Extract what we can from main page data
        validCoins.forEach(coin => {
            let hasBasicSocials = false;
            
            // Check if we already have social data from main page
            if (coin.urls) {
                const { website, twitter, chat, source_code } = coin.urls;
                if (website?.length > 0 || twitter?.length > 0 || chat?.length > 0 || source_code?.length > 0) {
                    hasBasicSocials = true;
                    
                    const projectData = {
                        name: coin.name,
                        symbol: coin.symbol,
                        slug: coin.slug,
                        website: website?.[0] || '',
                        twitter: twitter?.[0] || '',
                        github: source_code?.[0] || '',
                        telegram: '',
                        discord: '',
                        status: 'New Lead',
                        source: 'CoinMarketCap',
                        date_added: new Date().toISOString().split('T')[0],
                        details_url: `https://coinmarketcap.com/currencies/${coin.slug}/`,
                        extractionMethod: 'bulk-main-page'
                    };
                    
                    // Extract telegram/discord from chat array
                    if (chat) {
                        chat.forEach(link => {
                            if (link.includes('discord')) projectData.discord = link;
                            else if (link.includes('t.me')) projectData.telegram = link;
                        });
                    }
                    
                    if (projectData.website) {
                        projectData.domain = extractDomain(projectData.website);
                        coinsWithSocials.push(projectData);
                        stats.bulkExtracted++;
                    }
                }
            }
            
            // If no social data found in main page, mark for detail page extraction
            if (!hasBasicSocials) {
                coinsNeedingDetails.push(coin);
            }
        });
        
        logger.info(`Bulk extracted: ${coinsWithSocials.length} coins from main page`);
        logger.info(`Need detail pages: ${coinsNeedingDetails.length} coins`);
        
        // STEP 4: Parallel detail page processing for remaining coins
        if (coinsNeedingDetails.length > 0) {
            logger.info('STEP 4: Processing detail pages in parallel batches...');
            
            const batchSize = 5; // Process 5 coins in parallel
            const batches = [];
            
            for (let i = 0; i < coinsNeedingDetails.length; i += batchSize) {
                batches.push(coinsNeedingDetails.slice(i, i + batchSize));
            }
            
            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                const batch = batches[batchIndex];
                logger.info(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} coins)`);
                
                // Process batch in parallel
                const batchPromises = batch.map(async (coin) => {
                    try {
                        const detailUrl = `https://coinmarketcap.com/currencies/${coin.slug}/`;
                        
                        // Create new page for parallel processing
                        const detailPage = await page.context().newPage();
                        
                        await detailPage.goto(detailUrl, { 
                            waitUntil: 'domcontentloaded', 
                            timeout: 20000 
                        });
                        
                        await detailPage.waitForSelector(nextDataSelector, { 
                            state: 'attached', 
                            timeout: 20000 
                        });
                        
                        const detailData = await detailPage.evaluate((selector) => {
                            const nextData = JSON.parse(document.querySelector(selector).textContent);
                            return nextData?.props?.pageProps?.detailRes?.detail?.urls;
                        }, nextDataSelector);
                        
                        await detailPage.close();
                        
                        if (detailData) {
                            const projectData = {
                                name: coin.name,
                                symbol: coin.symbol,
                                slug: coin.slug,
                                website: detailData.website?.[0] || '',
                                twitter: detailData.twitter?.[0] || '',
                                github: detailData.source_code?.[0] || '',
                                telegram: '',
                                discord: '',
                                status: 'New Lead',
                                source: 'CoinMarketCap',
                                date_added: new Date().toISOString().split('T')[0],
                                details_url: detailUrl,
                                extractionMethod: 'parallel-detail-page'
                            };
                            
                            // Process chat links
                            if (detailData.chat) {
                                detailData.chat.forEach(link => {
                                    if (link.includes('discord')) projectData.discord = link;
                                    else if (link.includes('t.me')) projectData.telegram = link;
                                });
                            }
                            
                            if (projectData.website) {
                                projectData.domain = extractDomain(projectData.website);
                                stats.processed++;
                                return projectData;
                            }
                        }
                        
                        return null;
                        
                    } catch (error) {
                        logger.debug(`Error processing ${coin.name}: ${error.message}`);
                        stats.errors++;
                        return null;
                    }
                });
                
                // Wait for batch to complete
                const batchResults = await Promise.all(batchPromises);
                const validResults = batchResults.filter(result => result !== null);
                
                coinsWithSocials.push(...validResults);
                stats.detailPagesNeeded += batch.length;
                
                // Small delay between batches to be respectful
                if (batchIndex < batches.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }
        
        results = coinsWithSocials;
        
    } catch (error) {
        logger.error('Critical error in bulk scraper:', error);
        stats.errors++;
        throw error;
    } finally {
        await playHelper.cleanup();
    }
    
    stats.duration = Date.now() - startTime;
    
    // Enhanced statistics
    logger.info('=== BULK COINMARKETCAP SCRAPING STATISTICS ===');
    logger.info(`Coins Found: ${stats.found}`);
    logger.info(`Bulk Extracted (main page): ${stats.bulkExtracted}`);
    logger.info(`Detail Pages Processed: ${stats.detailPagesNeeded}`);
    logger.info(`Total Processed: ${stats.processed + stats.bulkExtracted}`);
    logger.info(`Coins Filtered: ${stats.filtered}`);
    logger.info(`Final Results: ${results.length}`);
    logger.info(`Errors: ${stats.errors}`);
    logger.info(`Duration: ${(stats.duration / 1000).toFixed(1)}s`);
    logger.info(`Efficiency: ${stats.bulkExtracted} bulk + ${stats.detailPagesNeeded} individual = ${((stats.bulkExtracted / (stats.bulkExtracted + stats.detailPagesNeeded)) * 100).toFixed(1)}% bulk extraction`);
    logger.info(`Average per coin: ${(stats.duration / Math.max(results.length, 1) / 1000).toFixed(1)}s`);
    
    if (results.length > 0) {
        logger.success(`🚀 BULK optimization SUCCESS: ${results.length} projects extracted in ${(stats.duration / 1000).toFixed(1)}s`);
    }
    
    return results;
}

module.exports = { scrapeCoinMarketCapBulk };