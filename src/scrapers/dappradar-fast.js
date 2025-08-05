const axios = require('axios');
const cheerio = require('cheerio');
const { createLogger } = require('../utils/logger');
const { extractDomain } = require('../utils/dedup');

/**
 * CREATIVE ScraperAPI DappRadar scraper - Professional anti-bot bypass
 * - Ultra Premium settings for maximum bypass capability
 * - Session management for consistency 
 * - Smart retry logic with different parameters
 * - Optimized for reliability and performance
 */
async function scrapeDappRadar() {
    const logger = createLogger('DappRadar-ScraperAPI');
    const startTime = Date.now();
    
    logger.info('Starting CREATIVE ScraperAPI DappRadar scraper (Professional bypass)');

    const apiKey = process.env.PROXY_PASS;
    if (!apiKey) {
        throw new Error('ScraperAPI key missing! Please set PROXY_PASS in .env file');
    }

    let results = [];
    const stats = { found: 0, processed: 0, filtered: 0, errors: 0, apiCalls: 0 };

    /**
     * CREATIVE ScraperAPI URL builder with multiple bypass strategies
     */
    function buildScraperApiUrl(url, strategy = 'ultra') {
        stats.apiCalls++;
        const encodedUrl = encodeURIComponent(url);
        const baseUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodedUrl}`;
        
        const strategies = {
            // ULTRA PREMIUM - Maximum anti-bot bypass
            ultra: `${baseUrl}&render=true&ultra_premium=true&session_number=1&country_code=US&device_type=desktop`,
            
            // PREMIUM - High-level bypass with residential proxy
            premium: `${baseUrl}&render=true&premium=true&session_number=2&country_code=CA&device_type=desktop`,
            
            // DATACENTER - Fast datacenter proxy with stealth
            datacenter: `${baseUrl}&render=true&session_number=3&country_code=GB&keep_headers=true`,
            
            // MOBILE - Mobile user agent bypass
            mobile: `${baseUrl}&render=true&ultra_premium=true&session_number=4&device_type=mobile&country_code=US`
        };
        
        return strategies[strategy] || strategies.ultra;
    }

    /**
     * SMART RETRY - Try different strategies if one fails
     */
    async function smartFetch(url, context = '') {
        const strategies = ['ultra', 'premium', 'datacenter'];
        
        for (let i = 0; i < strategies.length; i++) {
            const strategy = strategies[i];
            try {
                logger.info(`${context} - Trying ${strategy.toUpperCase()} strategy...`);
                
                const response = await axios.get(buildScraperApiUrl(url, strategy), {
                    timeout: 180000, // 3 minutes for challenges
                    headers: {
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Accept-Encoding': 'gzip, deflate',
                        'DNT': '1',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    }
                });
                
                logger.success(`${strategy.toUpperCase()} strategy succeeded for ${context}`);
                return response.data;
                
            } catch (error) {
                logger.warn(`${strategy.toUpperCase()} failed for ${context}: ${error.response?.status || error.message}`);
                
                if (i === strategies.length - 1) {
                    throw new Error(`All strategies failed for ${context}: ${error.message}`);
                }
                
                // Wait before trying next strategy
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    /**
     * CREATIVE HTML ANALYSIS - Multiple parsing strategies
     */
    function parseHtmlCreatively(html, context) {
        const $ = cheerio.load(html);
        
        // STRATEGY 1: Target known selectors
        let dapps = [];
        
        $('tr[data-testid="dapp-item-row"]').each((_, element) => {
            const nameElement = $(element).find('a.dapp-name-link');
            if (nameElement.length) {
                const name = nameElement.text().trim();
                const href = nameElement.attr('href');
                if (name && href) {
                    dapps.push({
                        name: name,
                        detailUrl: href.startsWith('http') ? href : `https://dappradar.com${href}`
                    });
                }
            }
        });
        
        // STRATEGY 2: Fallback to any dapp links
        if (dapps.length === 0) {
            $('a[href*="/dapp/"]').each((_, element) => {
                const name = $(element).text().trim();
                const href = $(element).attr('href');
                if (name && href && name.length > 2) {
                    dapps.push({
                        name: name,
                        detailUrl: href.startsWith('http') ? href : `https://dappradar.com${href}`
                    });
                }
            });
        }
        
        // STRATEGY 3: Pattern matching in text
        if (dapps.length === 0) {
            const text = $.text();
            const dappPattern = /\/dapp\/([a-zA-Z0-9-]+)/g;
            const matches = [...text.matchAll(dappPattern)];
            matches.forEach(match => {
                const slug = match[1];
                if (slug && slug.length > 2) {
                    dapps.push({
                        name: slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                        detailUrl: `https://dappradar.com/dapp/${slug}`
                    });
                }
            });
        }
        
        logger.info(`${context}: Found ${dapps.length} dApps using creative parsing`);
        
        // DEBUG: Save HTML if no dApps found
        if (dapps.length === 0) {
            const fs = require('fs');
            fs.writeFileSync(`DEBUG_${context.toLowerCase().replace(' ', '_')}.html`, html);
            logger.warn(`No dApps found, saved HTML to DEBUG_${context.toLowerCase().replace(' ', '_')}.html`);
        }
        
        return dapps;
    }

    try {
        // STEP 1: CREATIVE CATEGORY SCRAPING
        logger.info('STEP 1: Scraping categories with creative strategies...');
        
        const categories = [
            { name: 'DeFi', url: 'https://dappradar.com/rankings/category/defi' },
            { name: 'Games', url: 'https://dappradar.com/rankings/category/games' }
        ];
        
        let allDapps = [];
        
        for (const category of categories) {
            try {
                logger.info(`--- SCRAPING ${category.name.toUpperCase()} CATEGORY ---`);
                
                const html = await smartFetch(category.url, `${category.name} category`);
                const dapps = parseHtmlCreatively(html, category.name);
                
                allDapps.push(...dapps);
                logger.success(`${category.name}: Found ${dapps.length} dApps`);
                
                // Delay between categories to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 3000));
                
            } catch (error) {
                logger.error(`Failed to scrape ${category.name}: ${error.message}`);
                stats.errors++;
            }
        }
        
        // DEDUPLICATION
        const uniqueDapps = Array.from(new Map(allDapps.map(d => [d.detailUrl, d])).values());
        stats.found = uniqueDapps.length;
        
        if (stats.found === 0) {
            throw new Error('No dApps found in any category. Check ScraperAPI dashboard and debug HTML files.');
        }
        
        logger.success(`Found ${stats.found} unique dApps total`);
        
        // STEP 2: CREATIVE DETAIL SCRAPING (limit to 2 for testing)
        logger.info('STEP 2: Extracting details with creative strategies...');
        
        const dappsToProcess = uniqueDapps.slice(0, 2);
        logger.info(`Processing first ${dappsToProcess.length} dApps for testing...`);
        
        for (let i = 0; i < dappsToProcess.length; i++) {
            const dapp = dappsToProcess[i];
            
            try {
                logger.info(`[${i + 1}/${dappsToProcess.length}] Processing: ${dapp.name}`);
                
                const html = await smartFetch(dapp.detailUrl, dapp.name);
                const $ = cheerio.load(html);
                
                // CREATIVE WEBSITE EXTRACTION
                let website = '';
                
                // Strategy 1: Target selector
                website = $('a[data-testid="dapp-website-link"]').attr('href');
                
                // Strategy 2: Look for external links
                if (!website) {
                    $('a[href^="http"]').each((_, element) => {
                        const href = $(element).attr('href');
                        if (href && 
                            !href.includes('dappradar.com') &&
                            !href.includes('twitter.com') &&
                            !href.includes('t.me') &&
                            !href.includes('discord') &&
                            !href.includes('github')) {
                            website = href;
                            return false; // Break loop
                        }
                    });
                }
                
                // Strategy 3: Pattern matching
                if (!website) {
                    const text = $.text();
                    const urlPattern = /https?:\/\/(?!.*(?:dappradar|twitter|discord|telegram|github))[\w.-]+\.[a-z]{2,}/gi;
                    const matches = text.match(urlPattern);
                    if (matches && matches.length > 0) {
                        website = matches[0];
                    }
                }
                
                if (website) {
                    results.push({
                        name: dapp.name,
                        website: website,
                        status: 'New Lead',
                        source: 'DappRadar',
                        date_added: new Date().toISOString().split('T')[0],
                        domain: extractDomain(website),
                        details_url: dapp.detailUrl,
                        category: 'DApp'
                    });
                    stats.processed++;
                    logger.info(`✅ ${dapp.name}: Website: ${website}`);
                } else {
                    stats.filtered++;
                    logger.debug(`Skipping ${dapp.name}: no website found`);
                }
                
                // Rate limiting between requests
                await new Promise(resolve => setTimeout(resolve, 4000));
                
            } catch (error) {
                stats.errors++;
                logger.error(`Failed to process ${dapp.name}: ${error.message}`);
            }
        }
        
    } catch (error) {
        logger.error('Critical error in creative ScraperAPI scraper:', error.message);
        throw error;
    }
    
    stats.duration = Date.now() - startTime;
    
    // FINAL DEDUPLICATION
    const uniqueResults = {};
    results.forEach(item => {
        if (item.domain) {
            uniqueResults[item.domain] = item;
        }
    });
    
    const finalResults = Object.values(uniqueResults);
    
    logger.info('=== CREATIVE SCRAPERAPI RESULTS ===');
    logger.info(`DApps Found: ${stats.found}`);
    logger.info(`DApps Processed: ${stats.processed}`);
    logger.info(`DApps Filtered: ${stats.filtered}`);
    logger.info(`Final Unique Results: ${finalResults.length}`);
    logger.info(`API Calls Made: ${stats.apiCalls}`);
    logger.info(`Errors: ${stats.errors}`);
    logger.info(`Duration: ${(stats.duration / 1000).toFixed(1)}s`);
    logger.info(`Cost Estimate: ~$${(stats.apiCalls * 0.01).toFixed(2)} USD`);
    
    if (finalResults.length > 0) {
        logger.success(`🎉 CREATIVE ScraperAPI SUCCESS: ${finalResults.length} dApps extracted!`);
    } else {
        logger.error('❌ No results extracted. Check ScraperAPI dashboard and debug files.');
    }
    
    return finalResults;
}

module.exports = { scrapeDappRadar };