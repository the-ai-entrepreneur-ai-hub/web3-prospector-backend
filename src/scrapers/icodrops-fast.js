const { PlaywrightHelper } = require('../utils/playwright-helper');
const { extractDomain } = require('../utils/dedup');
const { createLogger } = require('../utils/logger');

/**
 * Fast ICODrops scraper using EXACT Apify approach
 * - Direct browser automation (no ScraperAPI)
 * - Same selectors and logic as working Apify scraper
 * - Reuses browser session
 */
async function scrapeICODrops() {
    const logger = createLogger('ICODrops-Fast');
    const startTime = Date.now();
    
    logger.info('Starting FAST ICODrops scraper using direct Playwright (Apify approach)');

    const playHelper = new PlaywrightHelper({
        headless: true,
        timeout: 60000,
        retries: 2
    });
    
    let results = [];
    const stats = { found: 0, processed: 0, filtered: 0, errors: 0 };

    try {
        // Initialize browser once and reuse
        await playHelper.initialize();
        const page = playHelper.page;
        
        // STEP 1: Get project list from main page (EXACT Apify approach)
        logger.info('STEP 1: Discovering project URLs from main page...');
        await playHelper.navigateTo('https://icodrops.com/');
        
        // Use EXACT selector from Apify
        const projectLinkSelector = '.All-Projects__item';
        await page.waitForSelector(projectLinkSelector, { timeout: 60000 });
        
        // Extract project URLs using EXACT Apify logic
        const projectUrls = await page.evaluate((selector) => {
            const links = document.querySelectorAll(selector);
            // Use a Set to automatically handle duplicate URLs found across columns
            const uniqueUrls = new Set();
            links.forEach(link => uniqueUrls.add(link.href));
            return Array.from(uniqueUrls);
        }, projectLinkSelector);
        
        if (!projectUrls || projectUrls.length === 0) {
            throw new Error('Could not find any project links on the main page. The website structure may have changed.');
        }
        
        stats.found = projectUrls.length;
        logger.success(`Found ${projectUrls.length} unique projects`);
        
        // Process all projects found
        const projectsToScrape = projectUrls;
        logger.info(`Processing all ${projectsToScrape.length} projects...`);
        
        // STEP 2: Process each project detail page (reusing same browser)
        for (let i = 0; i < projectsToScrape.length; i++) {
            const projectUrl = projectsToScrape[i];
            
            try {
                logger.info(`Processing ${i + 1}/${projectsToScrape.length}: ${projectUrl}`);
                
                // Navigate to project detail page (same browser session - FAST!)
                await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                
                // EXACT Apify wait condition
                await page.waitForSelector('h1.Project-Page-Header__name', { timeout: 150000 });
                logger.debug(`Project page loaded successfully: ${projectUrl}`);
                
                // Extract data using EXACT Apify logic
                const extractedData = await page.evaluate(() => {
                    const data = {
                        projectName: null,
                        description: null,
                        socialLinks: {},
                    };

                    // Extract Project Name (EXACT Apify selector)
                    data.projectName = document.querySelector('h1.Project-Page-Header__name')?.textContent.trim() || null;

                    // Extract Description (EXACT Apify selector)
                    data.description = document.querySelector('.Overview-Section-Description__text')?.textContent.trim().replace('...Show More', '').trim() || null;

                    // Extract Social Links (EXACT Apify logic)
                    const socialLinkElements = document.querySelectorAll('.Project-Page-Header__links-list a');
                    socialLinkElements.forEach(link => {
                        const textElement = link.querySelector('.capsule__text');
                        if (textElement) {
                            const text = textElement.textContent.trim().toLowerCase();
                            const url = link.href;

                            // EXACT Apify mapping logic
                            if (text.includes('twitter')) data.socialLinks.twitter = url;
                            else if (text.includes('medium')) data.socialLinks.medium = url;
                            else if (text.includes('telegram') && !data.socialLinks.telegram) data.socialLinks.telegram = url;
                            else if (text.includes('github')) data.socialLinks.github = url;
                            else if (text.includes('website')) data.socialLinks.website = url;
                            else if (text.includes('whitepaper')) data.socialLinks.whitepaper = url;
                        }
                    });

                    return data;
                });
                
                // Skip if no project name
                if (!extractedData.projectName) {
                    logger.debug(`Skipping project: no name found`);
                    stats.filtered++;
                    continue;
                }
                
                // Skip if no website
                if (!extractedData.socialLinks.website) {
                    logger.debug(`Skipping ${extractedData.projectName}: no website found`);
                    stats.filtered++;
                    continue;
                }
                
                // Convert to our standard format
                const projectData = {
                    name: extractedData.projectName,
                    website: extractedData.socialLinks.website,
                    status: 'New Lead',
                    source: 'ICODrops',
                    date_added: new Date().toISOString().split('T')[0],
                    domain: extractDomain(extractedData.socialLinks.website),
                    details_url: projectUrl,
                    description: extractedData.description
                };
                
                // Add all social fields found
                if (extractedData.socialLinks.twitter) projectData.twitter = extractedData.socialLinks.twitter;
                if (extractedData.socialLinks.telegram) projectData.telegram = extractedData.socialLinks.telegram;
                if (extractedData.socialLinks.github) projectData.github = extractedData.socialLinks.github;
                if (extractedData.socialLinks.medium) projectData.medium = extractedData.socialLinks.medium;
                if (extractedData.socialLinks.whitepaper) projectData.whitepaper = extractedData.socialLinks.whitepaper;
                
                results.push(projectData);
                stats.processed++;
                
                logger.info(`✅ ${extractedData.projectName}: Website: ${extractedData.socialLinks.website}, Twitter: ${extractedData.socialLinks.twitter || 'none'}, Telegram: ${extractedData.socialLinks.telegram || 'none'}`);
                
                // Small delay between requests
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                stats.errors++;
                logger.error(`Failed to process ${projectUrl}: ${error.message}`);
                continue;
            }
        }
        
    } catch (error) {
        logger.error('Critical error in fast ICODrops scraper:', error);
        stats.errors++;
        throw error;
    } finally {
        await playHelper.cleanup();
    }
    
    stats.duration = Date.now() - startTime;
    
    logger.info('=== FAST ICODROPS SCRAPING STATISTICS ===');
    logger.info(`Projects Found: ${stats.found}`);
    logger.info(`Projects Processed: ${stats.processed}`);
    logger.info(`Projects Filtered: ${stats.filtered}`);
    logger.info(`Projects Extracted: ${results.length}`);
    logger.info(`Errors: ${stats.errors}`);
    logger.info(`Duration: ${(stats.duration / 1000).toFixed(1)}s`);
    logger.info(`Average per project: ${(stats.duration / Math.max(stats.processed, 1) / 1000).toFixed(1)}s`);
    
    logger.success(`Fast ICODrops scraping completed: ${results.length} projects in ${(stats.duration / 1000).toFixed(1)}s`);
    
    // Deduplicate by domain
    const uniqueResults = {};
    results.forEach(item => {
        if (item.domain) {
            uniqueResults[item.domain] = item;
        }
    });
    
    return Object.values(uniqueResults);
}

module.exports = { scrapeICODrops };