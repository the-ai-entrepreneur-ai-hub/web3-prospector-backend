const axios = require('axios');
const cheerio = require('cheerio');
const { createLogger } = require('../utils/logger');
const { extractDomain } = require('../utils/dedup');

const logger = createLogger('DappRadar');

/**
 * Builds the ScraperAPI URL with the crucial ultra_premium parameter.
 * @param {string} url The URL to scrape.
 * @returns {string} The full ScraperAPI endpoint URL.
 */
function getScraperApiUrl(url) {
    const apiKey = process.env.PROXY_PASS; 
    if (!apiKey) {
        throw new Error('ScraperAPI key is missing! Please ensure PROXY_PASS is set in your .env file.');
    }
    const encodedUrl = encodeURIComponent(url);
    // 'render=true' => Use a headless browser.
    // 'ultra_premium=true' => Use premium proxies and advanced browser fingerprinting to solve tough challenges.
    return `http://api.scraperapi.com?api_key=${apiKey}&url=${encodedUrl}&render=true&ultra_premium=true`;
}

/**
 * Scrapes a DappRadar category to get a list of dApp detail page URLs.
 */
async function getDappUrlsFromCategory(category) {
    const targetUrl = `https://dappradar.com/rankings/category/${category.toLowerCase()}`;
    logger.info(`Fetching ${category} page via ScraperAPI (ULTRA PREMIUM)...`);

    try {
        const response = await axios.get(getScraperApiUrl(targetUrl), { timeout: 240000 }); // 4 minute timeout for ultra premium
        const html = response.data;
        const $ = cheerio.load(html);

        const dapps = [];
        $('tr[data-testid="dapp-item-row"]').each((_, element) => {
            const linkElement = $(element).find('a.dapp-name-link');
            if (linkElement.length) {
                dapps.push({
                    name: linkElement.text().trim(),
                    detailUrl: `https://dappradar.com${linkElement.attr('href')}`,
                });
            }
        });

        if (dapps.length === 0) {
            logger.warn(`Could not find any dApp rows in the HTML for ${category}. The page might be blocked or has changed structure.`);
            // Save the HTML for debugging if no dApps are found
            const fs = require('fs');
            fs.writeFileSync(`DEBUG_DAPPRADAR_${category}.html`, html);
            logger.info(`Saved HTML for ${category} to DEBUG_DAPPRADAR_${category}.html`);
        } else {
            logger.info(`Found ${dapps.length} dApp URLs in the ${category} category.`);
        }
        return dapps;
    } catch (error) {
        logger.error(`Failed to fetch or parse ${category}. Status: ${error.response?.status}. Error: ${error.message}`);
        return [];
    }
}

/**
 * Main function to scrape DappRadar using the ScraperAPI API Mode with Ultra Premium settings.
 */
async function scrapeDappRadar() {
    logger.info('Starting DappRadar scraper using ScraperAPI (API Mode - ULTRA PREMIUM)');
    const startTime = Date.now();
    const stats = { found: 0, processed: 0, unique: 0, errors: 0 };
    let allDapps = [];
    const categories = ['defi', 'games'];

    try {
        for (const category of categories) {
            const urls = await getDappUrlsFromCategory(category);
            allDapps.push(...urls);
        }

        const uniqueDapps = Array.from(new Map(allDapps.map(d => [d.detailUrl, d])).values());
        stats.found = uniqueDapps.length;

        if (stats.found === 0) {
            throw new Error("Failed to find any dApp URLs. Check ScraperAPI dashboard for errors and the saved debug HTML files.");
        }
        logger.success(`Found ${stats.found} unique dApps. Now processing details...`);

        const finalResults = [];
        for (const dapp of uniqueDapps.slice(0, 15)) { // Process up to 15 for the final test
            try {
                logger.info(`Fetching details for: ${dapp.name}`);
                const detailResponse = await axios.get(getScraperApiUrl(dapp.detailUrl), { timeout: 240000 });
                const $ = cheerio.load(detailResponse.data);
                const website = $('a[data-testid="dapp-website-link"]').attr('href');

                if (website) {
                    finalResults.push({
                        project_name: dapp.name,
                        website,
                        category: 'dApp',
                        details_url: dapp.detailUrl,
                        source: 'DappRadar',
                        domain: extractDomain(website),
                    });
                    stats.processed++;
                }
            } catch (error) {
                stats.errors++;
                logger.error(`Could not fetch details for ${dapp.name}: ${error.response?.status} - ${error.message}`);
            }
        }
        
        const uniqueByDomain = {};
        finalResults.forEach(item => { if (item.domain) uniqueByDomain[item.domain] = item; });
        allDapps = Object.values(uniqueByDomain);
        stats.unique = allDapps.length;

    } catch (error) {
        logger.error(`A critical error occurred in the DappRadar scraper: ${error.message}`);
    }

    const duration = Date.now() - startTime;
    logger.info('=== DappRadar SCRAPING STATISTICS ===');
    logger.info(`Initial DApp URLs Found: ${stats.found}`);
    logger.info(`Successfully Processed Details: ${stats.processed}`);
    logger.info(`Final Unique DApps Extracted: ${stats.unique}`);
    logger.info(`Errors: ${stats.errors}`);
    logger.info(`Duration: ${(duration / 1000).toFixed(1)}s`);
    logger.success(`DappRadar scraping completed: ${stats.unique} projects extracted.`);
    return allDapps;
}

module.exports = { scrapeDappRadar };