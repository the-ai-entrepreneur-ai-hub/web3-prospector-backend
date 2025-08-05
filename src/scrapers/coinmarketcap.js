const axios = require('axios');
const cheerio = require('cheerio');
const { extractDomain } = require('../utils/dedup');
const { createLogger } = require('../utils/logger');

async function scrapeCoinMarketCap() {
    const logger = createLogger('CoinMarketCap');
    const startTime = Date.now();
    
    logger.info('Starting CoinMarketCap scraper using ScraperAPI');

    const SCRAPER_API_KEY = process.env.PROXY_PASS || '2559defceafe447ae240c04a1a3ec4a3';
    if (!SCRAPER_API_KEY) {
        throw new Error('PROXY_PASS (ScraperAPI key) not found in environment variables');
    }
    logger.info(`Using ScraperAPI key: ${SCRAPER_API_KEY.slice(0, 8)}...`);
    
    let results = [];
    const stats = { found: 0, processed: 0, filtered: 0, errors: 0 };

    try {
        // Step 1: Get the main /new page HTML via ScraperAPI
        logger.info('STEP 1: Fetching CoinMarketCap /new page via ScraperAPI...');
        
        const mainPageUrl = 'https://api.scraperapi.com/?' + new URLSearchParams({
            api_key: SCRAPER_API_KEY,
            url: 'https://coinmarketcap.com/new/',
            render: 'true'
        });

        const response = await axios.get(mainPageUrl, {
            timeout: 60000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        
        // Step 1A: Extract structured data from __NEXT_DATA__ (names and slugs)
        logger.info('STEP 1A: Extracting coin list from __NEXT_DATA__...');
        let coins = [];
        
        try {
            const nextDataScript = $('script#__NEXT_DATA__').html();
            if (nextDataScript) {
                const nextData = JSON.parse(nextDataScript);
                const coinList = nextData?.props?.pageProps?.data?.data?.recentlyAddedList || [];
                
                coins = coinList.slice(0, 60).map(coin => ({
                    name: coin.name,
                    symbol: coin.symbol,
                    slug: coin.slug,
                    detailUrl: `https://coinmarketcap.com/currencies/${coin.slug}/`,
                    addedDate: coin.addedDate
                }));
                
                logger.success(`Extracted ${coins.length} coins from __NEXT_DATA__!`);
            }
        } catch (error) {
            logger.warn(`Could not parse __NEXT_DATA__: ${error.message}`);
        }

        // Step 1B: Fallback to HTML parsing if __NEXT_DATA__ failed
        if (coins.length === 0) {
            logger.info('STEP 1B: Fallback to HTML parsing...');
            const coinRows = $('table.cmc-table tbody tr').toArray();
            logger.info(`Found ${coinRows.length} rows in the table`);
            
            coinRows.slice(0, 60).forEach((row, index) => {
                try {
                    const $row = $(row);
                    const nameLink = $row.find('a.cmc-link').first();
                    const nameElement = nameLink.find('p:not(.coin-item-symbol)').first();
                    const symbolElement = nameLink.find('p.coin-item-symbol').first();
                    
                    if (nameElement.length && symbolElement.length) {
                        const href = nameLink.attr('href');
                        const slug = href ? href.split('/currencies/')[1]?.split('/')[0] : null;
                        
                        if (slug) {
                            coins.push({
                                name: nameElement.text().trim(),
                                symbol: symbolElement.text().trim(),
                                slug: slug,
                                detailUrl: `https://coinmarketcap.com/currencies/${slug}/`
                            });
                        }
                    }
                } catch (error) {
                    logger.debug(`Error parsing row ${index}: ${error.message}`);
                }
            });
        }

        stats.found = coins.length;
        logger.success(`Found ${coins.length} coins to process`);

        if (coins.length === 0) {
            throw new Error('No coins found in the page. Selectors may need updating.');
        }

        // Step 2: Process detail pages in parallel batches - ALL coins need detail pages for social links
        logger.info('STEP 2: Processing detail pages in parallel batches for social links...');
        
        const processedCoins = [];
        
        // Filter out meme coins first
        const validCoins = coins.filter(coin => {
            const name = coin.name.toLowerCase();
            if (/\b(doge|shib|pepe|meme|inu|baby|moon|safe|elon)\b/.test(name)) {
                logger.debug(`Filtering out potential meme coin: ${coin.name}`);
                stats.filtered++;
                return false;
            }
            return true;
        });

        logger.info(`Processing ${validCoins.length} coins (${stats.filtered} meme coins filtered)`);

        if (validCoins.length > 0) {
            // SEQUENTIAL processing to avoid rate limits!
            const maxDetailPages = Math.min(validCoins.length, 10); // Limit to 10 total
            
            logger.info(`Processing ${maxDetailPages} coins sequentially to avoid rate limits...`);
            
            for (let i = 0; i < maxDetailPages; i++) {
                const coin = validCoins[i];
                
                try {
                    logger.info(`Processing ${i + 1}/${maxDetailPages}: ${coin.name}`);
                    
                    const detailPageUrl = 'https://api.scraperapi.com/?' + new URLSearchParams({
                        api_key: SCRAPER_API_KEY,
                        url: coin.detailUrl,
                        render: 'true' // Need JS rendering for __NEXT_DATA__ (like Apify)
                    });

                    const detailResponse = await axios.get(detailPageUrl, {
                        timeout: 45000, // Longer timeout needed for JS rendering
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    });

                    const html = detailResponse.data;
                    const $detail = cheerio.load(html);
                        
                        // Extract ALL available fields from detail page
                        let website = '';
                        let twitter = '';
                        let telegram = '';
                        let email = '';
                        let discord = '';
                        let github = '';
                        let linkedin = '';

                        // Extract from __NEXT_DATA__ using the EXACT Apify approach that works
                        try {
                            const nextDataScript = $detail('script#__NEXT_DATA__').html();
                            if (nextDataScript) {
                                const pageData = JSON.parse(nextDataScript);
                                const urls = pageData?.props?.pageProps?.detailRes?.detail?.urls;
                                
                                if (urls) {
                                    // Extract website
                                    if (urls.website && urls.website.length > 0) {
                                        website = urls.website[0];
                                    }
                                    
                                    // Extract Twitter
                                    if (urls.twitter && urls.twitter.length > 0) {
                                        twitter = urls.twitter[0];
                                    }
                                    
                                    // Extract GitHub
                                    if (urls.source_code && urls.source_code.length > 0) {
                                        github = urls.source_code[0];
                                    }
                                    
                                    // Extract Discord/Telegram from chat array (EXACT Apify logic)
                                    if (urls.chat && urls.chat.length > 0) {
                                        urls.chat.forEach(link => {
                                            if (link.includes('discord')) {
                                                discord = link;
                                            } else if (link.includes('t.me')) {
                                                telegram = link;
                                            }
                                        });
                                    }
                                    
                                    logger.info(`✅ ${coin.name}: Found URLs - Website: ${website || 'none'}, Twitter: ${twitter || 'none'}, Telegram: ${telegram || 'none'}`);
                                } else {
                                    logger.warn(`${coin.name}: No URLs found in __NEXT_DATA__`);
                                }
                            }
                        } catch (e) {
                            logger.error(`${coin.name}: Could not parse __NEXT_DATA__: ${e.message}`);
                        }

                        // Fallback: comprehensive search through all external links
                        if (!website) {
                            const allExternalLinks = $detail('a[href^="http"]').toArray();
                            
                            // Look for obvious website indicators
                            for (const link of allExternalLinks) {
                                const href = $(link).attr('href');
                                const text = $(link).text().toLowerCase().trim();
                                
                                // Skip CoinMarketCap's own links and common ad/tracking domains
                                if (href.includes('coinmarketcap.com') || 
                                    href.includes('google.com') ||
                                    href.includes('binance.com') ||
                                    href.includes('youtube.com') ||
                                    href.includes('facebook.com') ||
                                    href.includes('twitter.com') ||
                                    href.includes('t.me') ||
                                    href.includes('discord') ||
                                    href.includes('reddit.com') ||
                                    href.includes('linkedin.com')) {
                                    continue;
                                }
                                
                                // Look for actual project websites
                                if (text.includes('website') || 
                                    text.includes('official') ||
                                    text.includes('homepage') ||
                                    text.includes(coin.slug) ||
                                    (href.includes('.org') || href.includes('.io') || href.includes('.com')) &&
                                    href.length < 100) {
                                    website = href;
                                    logger.debug(`Found website via text analysis: ${website}`);
                                    break;
                                }
                            }
                            
                            // Last resort: look for the first reasonable external link
                            if (!website && allExternalLinks.length > 0) {
                                for (const link of allExternalLinks.slice(0, 20)) {
                                    const href = $(link).attr('href');
                                    
                                    if (href && !href.includes('coinmarketcap.com') && 
                                        !href.includes('google.com') &&
                                        !href.includes('binance.com') &&
                                        (href.includes('.org') || href.includes('.io') || href.includes('.com')) &&
                                        href.length < 100) {
                                        website = href;
                                        logger.debug(`Found website via fallback: ${website}`);
                                        break;
                                    }
                                }
                            }
                        }

                        // Social links are now extracted from __NEXT_DATA__ above
                        // This is much more reliable than parsing HTML

                        // Extract email
                        const mailtoLink = $detail('a[href^="mailto:"]').first();
                        if (mailtoLink.length) {
                            email = mailtoLink.attr('href').replace('mailto:', '');
                        }

                        // If still no website found, use a very broad approach
                        if (!website) {
                            const allLinks = $detail('a[href^="http"]').toArray();
                            logger.debug(`${coin.name}: Analyzing ${allLinks.length} external links`);
                            
                            // Find the first unique domain that's not a known platform
                            const seenDomains = new Set();
                            for (const link of allLinks) {
                                const href = $(link).attr('href');
                                try {
                                    const url = new URL(href);
                                    const domain = url.hostname.toLowerCase();
                                    
                                    // Skip known platforms and CMC itself
                                    if (domain.includes('coinmarketcap') || 
                                        domain.includes('twitter') || 
                                        domain.includes('x.com') ||
                                        domain.includes('t.me') ||
                                        domain.includes('discord') ||
                                        domain.includes('github') ||
                                        domain.includes('linkedin') ||
                                        domain.includes('facebook') ||
                                        domain.includes('youtube') ||
                                        domain.includes('google') ||
                                        domain.includes('binance') ||
                                        domain.includes('reddit') ||
                                        seenDomains.has(domain)) {
                                        continue;
                                    }
                                    
                                    seenDomains.add(domain);
                                    website = href;
                                    logger.debug(`${coin.name}: Using first unique domain as website: ${website}`);
                                    break;
                                } catch (e) {
                                    continue;
                                }
                            }
                        }

                        // Skip if still no website found
                        if (!website) {
                            logger.debug(`Skipping ${coin.name}: no website found after comprehensive search`);
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
                            details_url: coin.detailUrl,
                            symbol: coin.symbol
                        };

                        // Add ALL found social fields - NONE left out!
                        if (twitter) projectData.twitter = twitter;
                        if (telegram) projectData.telegram = telegram;
                        if (email) projectData.email = email;
                        if (discord) projectData.discord = discord;
                        if (github) projectData.github = github;
                        if (linkedin) projectData.linkedin = linkedin;

                    processedCoins.push(projectData);
                    stats.processed++;
                    logger.info(`✅ Successfully processed ${coin.name} -> ${website}`);
                    
                } catch (error) {
                    stats.errors++;
                    logger.error(`Failed to process ${coin.name}: ${error.message}`);
                }

                // Rate limiting delay - be respectful to ScraperAPI
                if (i < maxDetailPages - 1) { // Don't wait after last request
                    logger.info(`Waiting 3 seconds before next request...`);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }
        }

        results = processedCoins;

        logger.success(`STEP 2 SUCCESS: Processed ${stats.processed} coins successfully`);

    } catch (error) {
        logger.error('Critical error in CoinMarketCap scraper:', error);
        stats.errors++;
        throw error;
    }
    
    stats.duration = Date.now() - startTime;
  
    logger.info('=== COINMARKETCAP SCRAPING STATISTICS ===');
    logger.info(`Coins Found: ${stats.found}`);
    logger.info(`Coins Processed: ${stats.processed}`);
    logger.info(`Coins Filtered: ${stats.filtered}`);
    logger.info(`Projects Extracted: ${results.length}`);
    logger.info(`Errors: ${stats.errors}`);
    logger.info(`Duration: ${(stats.duration / 1000).toFixed(1)}s`);
    
    logger.success(`CoinMarketCap scraping completed: ${results.length} projects extracted.`);
    
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