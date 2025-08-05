const { createPlaywrightHelper } = require('../utils/playwright-helper');
const { createLogger } = require('../utils/logger');
const { extractDomain } = require('../utils/dedup');

/**
 * OPTIMIZED: Bulk ICODrops scraper - Maximum efficiency with parallel processing
 * 
 * Key Optimizations:
 * 1. Bulk extract project URLs from main page
 * 2. Process detail pages in parallel batches
 * 3. Smart error handling and retries
 * 4. Efficient resource management
 */
async function scrapeICODropsBulk() {
    const logger = createLogger('ICODrops-Bulk');
    const startTime = Date.now();
    
    logger.info('Starting OPTIMIZED ICODrops bulk scraper');
    
    const playHelper = createPlaywrightHelper();
    
    const stats = {
        found: 0,
        processed: 0,
        filtered: 0,
        errors: 0,
        parallelBatches: 0
    };
    
    let results = [];
    
    try {
        // Initialize browser
        const { page } = await playHelper.initialize();
        logger.info('Browser initialized for bulk extraction');
        
        // STEP 1: Bulk extract all project URLs from main page
        logger.info('STEP 1: Bulk extracting project URLs...');
        
        await page.goto('https://icodrops.com/', { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
        });
        
        // Enhanced URL extraction with multiple selectors
        const projectUrls = await page.evaluate(() => {
            const urls = new Set();
            
            // Strategy 1: Main project links
            document.querySelectorAll('a[href*="/"]').forEach(link => {
                const href = link.href;
                if (href && href.includes('icodrops.com/') && 
                    !href.includes('/category/') && 
                    !href.includes('/tag/') && 
                    !href.includes('/#') &&
                    href !== 'https://icodrops.com/' &&
                    href.split('/').length >= 4) {
                    urls.add(href);
                }
            });
            
            // Strategy 2: Project cards and tiles  
            document.querySelectorAll('.col-12, .col-md-6, .col-lg-4, .project-card, .ico-card').forEach(card => {
                const link = card.querySelector('a[href*="icodrops.com/"]');
                if (link && link.href && !link.href.includes('/category/') && !link.href.includes('/tag/')) {
                    urls.add(link.href);
                }
            });
            
            // Strategy 3: Title links
            document.querySelectorAll('h2 a, h3 a, h4 a').forEach(titleLink => {
                if (titleLink.href && titleLink.href.includes('icodrops.com/') && 
                    !titleLink.href.includes('/category/')) {
                    urls.add(titleLink.href);
                }
            });
            
            return Array.from(urls).filter(url => {
                // Additional filtering
                const segments = url.split('/');
                const lastSegment = segments[segments.length - 1] || segments[segments.length - 2];
                return lastSegment && lastSegment.length > 1 && !lastSegment.includes('?');
            });
        });
        
        if (!projectUrls || projectUrls.length === 0) {
            throw new Error('No project URLs found on main page');
        }
        
        stats.found = projectUrls.length;
        logger.success(`Found ${projectUrls.length} project URLs for bulk processing`);
        
        // STEP 2: Parallel batch processing of detail pages
        logger.info('STEP 2: Processing project details in parallel batches...');
        
        const batchSize = 8; // Process 8 projects in parallel (optimized for ICODrops)
        const batches = [];
        
        for (let i = 0; i < projectUrls.length; i += batchSize) {
            batches.push(projectUrls.slice(i, i + batchSize));
        }
        
        logger.info(`Processing ${batches.length} batches of ${batchSize} projects each`);
        
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            logger.info(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} projects)`);
            
            // Process batch in parallel
            const batchPromises = batch.map(async (projectUrl) => {
                let detailPage = null;
                
                try {
                    // Create new page for parallel processing
                    detailPage = await page.context().newPage();
                    
                    await detailPage.goto(projectUrl, { 
                        waitUntil: 'domcontentloaded', 
                        timeout: 25000 
                    });
                    
                    // Extract project data using optimized selectors
                    const projectData = await detailPage.evaluate(() => {
                        const data = {
                            projectName: null,
                            description: null,
                            socialLinks: {
                                website: null,
                                twitter: null,
                                telegram: null,
                                medium: null,
                                github: null,
                                whitepaper: null
                            }
                        };

                        // Enhanced name extraction
                        const nameSelectors = [
                            'h1.Project-Page-Header__name',
                            'h1',
                            '.project-title',
                            '.ico-title'
                        ];
                        
                        for (const selector of nameSelectors) {
                            const element = document.querySelector(selector);
                            if (element && element.textContent.trim()) {
                                data.projectName = element.textContent.trim();
                                break;
                            }
                        }

                        // Enhanced description extraction
                        const descriptionSelectors = [
                            '.Overview-Section-Description__text',
                            '.project-description',
                            '.description',
                            'p:first-of-type'
                        ];
                        
                        for (const selector of descriptionSelectors) {
                            const element = document.querySelector(selector);
                            if (element && element.textContent.trim()) {
                                data.description = element.textContent.trim()
                                    .replace('...Show More', '')
                                    .replace(/\s+/g, ' ')
                                    .trim();
                                if (data.description.length > 50) break;
                            }
                        }

                        // Enhanced social links extraction with multiple strategies
                        const socialLinkElements = document.querySelectorAll('a[href]');
                        socialLinkElements.forEach(link => {
                            const href = link.href;
                            const text = link.textContent.toLowerCase().trim();
                            
                            // Website detection
                            if ((text.includes('website') || text.includes('official') || 
                                 link.querySelector('.capsule__text')?.textContent.toLowerCase().includes('website')) &&
                                !href.includes('icodrops.com') && 
                                !href.includes('twitter.com') && 
                                !href.includes('t.me') &&
                                !data.socialLinks.website) {
                                data.socialLinks.website = href;
                            }
                            
                            // Twitter detection
                            else if (href.includes('twitter.com') || href.includes('x.com')) {
                                data.socialLinks.twitter = href;
                            }
                            
                            // Telegram detection
                            else if (href.includes('t.me') && !data.socialLinks.telegram) {
                                data.socialLinks.telegram = href;
                            }
                            
                            // Medium detection
                            else if (href.includes('medium.com')) {
                                data.socialLinks.medium = href;
                            }
                            
                            // GitHub detection
                            else if (href.includes('github.com')) {
                                data.socialLinks.github = href;
                            }
                            
                            // Whitepaper detection
                            else if (text.includes('whitepaper') || text.includes('white paper') || 
                                     href.includes('whitepaper') || href.includes('.pdf')) {
                                data.socialLinks.whitepaper = href;
                            }
                        });
                        
                        // Fallback: If no website found, look for non-social external links
                        if (!data.socialLinks.website) {
                            socialLinkElements.forEach(link => {
                                const href = link.href;
                                if (href && 
                                    !href.includes('icodrops.com') &&
                                    !href.includes('twitter.com') &&
                                    !href.includes('x.com') &&
                                    !href.includes('t.me') &&
                                    !href.includes('discord') &&
                                    !href.includes('github.com') &&
                                    !href.includes('medium.com') &&
                                    !href.includes('facebook.com') &&
                                    !href.includes('youtube.com') &&
                                    !href.includes('linkedin.com') &&
                                    href.includes('.')) {
                                    data.socialLinks.website = href;
                                    return;
                                }
                            });
                        }

                        return data;
                    });

                    await detailPage.close();
                    detailPage = null;

                    // Process extracted data
                    if (projectData.projectName && projectData.socialLinks.website) {
                        const result = {
                            name: projectData.projectName,
                            website: projectData.socialLinks.website,
                            status: 'New Lead',
                            source: 'ICODrops',
                            date_added: new Date().toISOString().split('T')[0],
                            domain: extractDomain(projectData.socialLinks.website),
                            details_url: projectUrl,
                            description: projectData.description || '',
                            extractionMethod: 'parallel-bulk'
                        };

                        // Add social links
                        if (projectData.socialLinks.twitter) result.twitter = projectData.socialLinks.twitter;
                        if (projectData.socialLinks.telegram) result.telegram = projectData.socialLinks.telegram;
                        if (projectData.socialLinks.medium) result.medium = projectData.socialLinks.medium;
                        if (projectData.socialLinks.github) result.github = projectData.socialLinks.github;
                        if (projectData.socialLinks.whitepaper) result.whitepaper = projectData.socialLinks.whitepaper;

                        stats.processed++;
                        return result;
                    }

                    return null;

                } catch (error) {
                    logger.debug(`Error processing ${projectUrl}: ${error.message}`);
                    stats.errors++;
                    return null;
                } finally {
                    if (detailPage) {
                        try {
                            await detailPage.close();
                        } catch (e) {
                            // Ignore close errors
                        }
                    }
                }
            });

            // Wait for batch to complete
            const batchResults = await Promise.all(batchPromises);
            const validResults = batchResults.filter(result => result !== null);
            
            results.push(...validResults);
            stats.parallelBatches++;
            
            logger.info(`Batch ${batchIndex + 1} complete: ${validResults.length}/${batch.length} projects extracted`);
            
            // Small delay between batches to be respectful
            if (batchIndex < batches.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }
        
    } catch (error) {
        logger.error('Critical error in bulk ICODrops scraper:', error);
        stats.errors++;
        throw error;
    } finally {
        await playHelper.cleanup();
    }
    
    stats.duration = Date.now() - startTime;
    
    // Enhanced statistics
    logger.info('=== BULK ICODROPS SCRAPING STATISTICS ===');
    logger.info(`Projects Found: ${stats.found}`);
    logger.info(`Projects Processed: ${stats.processed}`);
    logger.info(`Parallel Batches: ${stats.parallelBatches}`);
    logger.info(`Final Results: ${results.length}`);
    logger.info(`Errors: ${stats.errors}`);
    logger.info(`Duration: ${(stats.duration / 1000).toFixed(1)}s`);
    logger.info(`Average per project: ${(stats.duration / Math.max(results.length, 1) / 1000).toFixed(1)}s`);
    logger.info(`Parallel Efficiency: ${(results.length / (stats.duration / 1000) * 60).toFixed(1)} projects/minute`);
    
    if (results.length > 0) {
        logger.success(`🚀 BULK optimization SUCCESS: ${results.length} projects extracted in ${(stats.duration / 1000).toFixed(1)}s`);
    }
    
    return results;
}

module.exports = { scrapeICODropsBulk };