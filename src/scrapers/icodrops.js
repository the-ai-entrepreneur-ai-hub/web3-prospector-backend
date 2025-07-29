const { PlaywrightHelper } = require('../utils/playwright-helper');
const { extractDomain } = require('../utils/dedup');
const { createLogger } = require('../utils/logger');
const { createProxyRotator } = require('../utils/proxy');

/**
 * Enhanced ICODrops scraper with proxy support and advanced logging.
 * 
 * Scrapes project data from ICODrops including name, website, social links,
 * and filters out meme/points farming categories as per execution plan.
 * Now includes comprehensive monitoring and much higher project limits.
 */
async function scrapeICODrops() {
  const logger = createLogger('ICODrops');
  const proxyRotator = createProxyRotator();
  const startTime = Date.now();
  
  logger.info('Starting enhanced ICODrops scraper with proxy rotation');
  
  const playHelper = new PlaywrightHelper({
    headless: true,
    timeout: 30000,
    retries: 3
  });
  
  const results = [];
  const stats = {
    found: 0,
    processed: 0,
    filtered: 0,
    errors: 0,
    enriched: 0,
    duration: 0
  };
  
  try {
    // Get proxy configuration
    const proxyData = proxyRotator.getNextProxy();
    
    // Initialize browser with stealth mode
    await playHelper.initialize({
      host: proxyData.proxy.host,
      port: proxyData.proxy.port,
      username: proxyData.proxy.username,
      password: proxyData.proxy.password
    });
    
    logger.info(`Using proxy: ${proxyData.proxy.id} for ICODrops scraping`);
    
    logger.info('Navigating to ICODrops main page');
    const navigationStart = Date.now();
    
    await playHelper.navigateTo('https://icodrops.com/');
    
    const navigationTime = Date.now() - navigationStart;
    logger.info(`Page loaded in ${navigationTime}ms`);
    
    const selectors = playHelper.getSelectors('icodrops');
    const { projectCards, projectName, description, socialLinks, projectInfo } = selectors.selectors;

    // Wait for project list to load
    logger.debug('Waiting for project list to load');
    await playHelper.waitForElement(projectCards, { timeout: 60000 });
    
    // Scroll down to load more projects if available
    await playHelper.scrollDownUntilNoNewContent(projectCards[0], 500, 5); // Scroll 5 times, 500ms delay

    logger.info('Extracting project URLs from all sections');
    
    // Extract project URLs from the main page
    const projectUrls = await playHelper.page.evaluate((cardSelectors) => {
      const links = document.querySelectorAll(cardSelectors.join(', '));
      const urls = new Set();
      links.forEach(link => {
        const href = link.querySelector('a')?.href; // Get href from the anchor tag within the card
        if (href && href.includes('icodrops.com') && 
            !href.includes('/category/') && !href.includes('/tag/')) {
          urls.add(href);
        }
      });
      return Array.from(urls);
    }, projectCards);
    
    logger.info(`Found ${projectUrls.length} project URLs.`);
    
    stats.found = projectUrls.length;
    logger.success(`Found ${projectUrls.length} project URLs across all categories`);
    
    // Process much more projects (100 instead of 20)
    const maxProjects = Math.min(projectUrls.length, 100);
    const urlsToProcess = projectUrls.slice(0, maxProjects);
    
    logger.info(`Processing ${urlsToProcess.length} projects (increased from 20 to 100)`);
    logger.startProgress('project-processing', urlsToProcess.length, 'Processing project details');
    
    for (let i = 0; i < urlsToProcess.length; i++) {
      const url = urlsToProcess[i];
      
      try {
        logger.updateProgress('project-processing', i + 1, `Project ${i + 1}/${urlsToProcess.length}`);
        
        const pageLoadStart = Date.now();
        await playHelper.navigateTo(url);
        
        const pageLoadTime = Date.now() - pageLoadStart;
        logger.debug(`Loaded project page in ${pageLoadTime}ms: ${url}`);
        
        // Wait for project title
        await playHelper.waitForElement(projectName, { timeout: 15000 });
        
        // Extract comprehensive project data
        const projectData = await playHelper.page.evaluate((nameSelectors, descSelectors, socialLinkSelectors, infoSelectors) => {
          const data = {
            name: null,
            website: null,
            description: null,
            category: null,
            sale_type: 'unknown',
            twitter: null,
            telegram: null,
            discord: null,
            github: null,
            medium: null,
            whitepaper: null,
            reddit: null,
            linkedin: null,
            tokenSymbol: null,
            totalRaise: null,
            launch_date: null,
            endDate: null,
            roi: null
          };
          
          // Extract project name
          for (const selector of nameSelectors) {
            const element = document.querySelector(selector);
            if (element) {
              data.name = element.textContent.trim();
              break;
            }
          }
          
          // Extract enhanced description
          for (const selector of descSelectors) {
            const element = document.querySelector(selector);
            if (element) {
              data.description = element.textContent.trim().replace('...Show More', '').trim();
              break;
            }
          }
          
          // Extract comprehensive social links and website
          const socialLinks = document.querySelectorAll(socialLinkSelectors.join(', '));
          socialLinks.forEach(link => {
            if (!link.href) return;
            
            const textElement = link.querySelector('.capsule__text, .text, span');
            const text = textElement ? textElement.textContent.trim().toLowerCase() : '';
            const url = link.href.toLowerCase();
            const linkText = `${url} ${text}`;
            
            // Categorize links more comprehensively
            if (text.includes('website') || (linkText.includes('www.') && !url.includes('twitter') && !url.includes('telegram') && !url.includes('discord'))) {
              data.website = link.href;
            } else if (text.includes('twitter') || url.includes('twitter.com') || url.includes('x.com')) {
              data.twitter = link.href;
            } else if (text.includes('telegram') || url.includes('t.me')) {
              data.telegram = link.href;
            } else if (text.includes('discord') || url.includes('discord')) {
              data.discord = link.href;
            } else if (text.includes('github') || url.includes('github.com')) {
              data.github = link.href;
            } else if (text.includes('medium') || url.includes('medium.com')) {
              data.medium = link.href;
            } else if (text.includes('whitepaper') || text.includes('white paper')) {
              data.whitepaper = link.href;
            } else if (text.includes('reddit') || url.includes('reddit.com')) {
              data.reddit = link.href;
            } else if (text.includes('linkedin') || url.includes('linkedin.com')) {
              data.linkedin = link.href;
            }
          });
          
          // Extract comprehensive project metadata
          const infoElements = document.querySelectorAll(infoSelectors.join(', '));
          infoElements.forEach(element => {
            const label = element.querySelector('.Project-Page-Info__item-label, .label, dt');
            const value = element.querySelector('.Project-Page-Info__item-value, .value, dd');
            
            if (label && value) {
              const labelText = label.textContent.trim().toLowerCase();
              const valueText = value.textContent.trim();
              
              if (labelText.includes('category') || labelText.includes('type')) {
                data.category = valueText;
              } else if (labelText.includes('symbol') || labelText.includes('token')) {
                data.tokenSymbol = valueText;
              } else if (labelText.includes('raise') || labelText.includes('funding')) {
                data.totalRaise = valueText;
              } else if (labelText.includes('start') || labelText.includes('begin')) {
                data.launch_date = valueText;
              } else if (labelText.includes('end') || labelText.includes('finish')) {
                data.endDate = valueText;
              } else if (labelText.includes('roi') || labelText.includes('return')) {
                data.roi = valueText;
              }
            }
          });
          
          // Try alternative selectors for missing website data
          if (!data.website) {
            const websiteLinks = document.querySelectorAll('a[href]:not([href*="twitter"]):not([href*="telegram"]):not([href*="discord"]):not([href*="github"])');
            for (const link of websiteLinks) {
              const url = link.href.toLowerCase();
              if (url.startsWith('http') && !url.includes('icodrops.com') && 
                  !url.includes('coinmarketcap') && !url.includes('coingecko')) {
                data.website = link.href;
                break;
              }
            }
          }
          
          return data;
        }, projectName, description, socialLinks, projectInfo);
        
        // Build complete project data in the required format
        const fullProjectData = {
          project_name: projectData.name,
          website: projectData.website || null,
          sale_type: projectData.sale_type || 'ICO/IEO', // Default sale type
          launchpad: 'ICODrops',
          category: projectData.category || 'Blockchain', // Default category if not found
          launch_date: projectData.launch_date || null,
          funding_raised: projectData.totalRaise || 'N/A',
          details_url: url,
          source: 'ICODrops'
        };

        // Enhanced filtering logic
        if (!fullProjectData.project_name) {
          logger.debug(`Skipping project: missing name - ${url}`);
          stats.filtered++;
          continue;
        }
        
        // Filter out unwanted categories
        if (fullProjectData.category) {
          const category = fullProjectData.category.toLowerCase();
          if (category.includes('meme') || 
              category.includes('points farming') || 
              category.includes('point farming') ||
              (category.includes('gaming') && category.includes('nft') && fullProjectData.description && fullProjectData.description.length < 100)) {
            logger.debug(`Filtering out ${fullProjectData.project_name}: category ${fullProjectData.category}`);
            stats.filtered++;
            continue;
          }
        }
        
        // Filter projects without meaningful web presence
        if (!fullProjectData.website && !projectData.twitter && !projectData.telegram) {
          logger.debug(`Filtering out ${fullProjectData.project_name}: no web presence`);
          stats.filtered++;
          continue;
        }
        
        // Extract domain from website for deduplication
        if (fullProjectData.website) {
          fullProjectData.domain = extractDomain(fullProjectData.website);
        }
        
        results.push(fullProjectData);
        stats.processed++;
        logger.debug(`✓ Extracted: ${fullProjectData.project_name} - ${fullProjectData.website || 'No website'}`);
        
        // Shorter delay with proxy rotation
        await playHelper.sleep(1500);
        
      } catch (error) {
        stats.errors++;
        logger.error(`Error processing ${url}: ${error.message}`);
        continue;
      }
    }
    
    logger.completeProgress('project-processing', `${results.length} projects extracted successfully`);
    
    // Mark proxy as successful
    proxyRotator.markProxySuccess(proxyData.index, Date.now() - startTime);
    
    // Deduplicate results by domain before returning
    const uniqueResults = {};
    results.forEach(item => {
      if (item.domain && !uniqueResults[item.domain]) {
        uniqueResults[item.domain] = item;
      } else if (!item.domain && !uniqueResults[item.details_url]) { // Fallback for items without domain
        uniqueResults[item.details_url] = item;
      }
    });
    results.length = 0;
    results.push(...Object.values(uniqueResults));
    
  } catch (error) {
    stats.errors++;
    logger.error('ICODrops scraper error:', error);
    
    // Mark proxy as failed if it was a connection issue
    if (error.message.includes('net::') || error.message.includes('timeout')) {
      proxyRotator.markProxyFailed(proxyData?.index || 0, error);
    }
  } finally {
    await playHelper.cleanup();
  }
  
  // Calculate final statistics
  stats.duration = Date.now() - startTime;
  stats.enriched = results.length;
  
  // Log comprehensive statistics
  logger.info('=== ICODROPS SCRAPING STATISTICS ===');
  logger.info(`Total Projects Found: ${stats.found}`);
  logger.info(`Projects Processed: ${stats.processed}`);
  logger.info(`Projects Filtered: ${stats.filtered}`);
  logger.info(`Projects Enriched: ${stats.enriched}`);
  logger.info(`Errors Encountered: ${stats.errors}`);
  logger.info(`Total Duration: ${(stats.duration / 1000).toFixed(1)}s`);
  logger.info(`Average Time per Project: ${stats.processed > 0 ? Math.round(stats.duration / stats.processed) : 0}ms`);
  logger.info(`Success Rate: ${stats.found > 0 ? ((stats.processed / stats.found) * 100).toFixed(1) : '0.0'}%`);
  
  // Log proxy statistics
  proxyRotator.logStats();
  
  logger.success(`ICODrops scraping completed: ${results.length} projects extracted in ${(stats.duration / 1000).toFixed(1)}s`);
  
  return results;
}

module.exports = { scrapeICODrops };