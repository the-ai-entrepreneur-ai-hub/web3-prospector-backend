const { PlaywrightHelper } = require('../utils/playwright-helper');
const { extractDomain } = require('../utils/dedup');
const { createLogger } = require('../utils/logger');
const { createProxyRotator } = require('../utils/proxy');

/**
 * DappRadar scraper for decentralized applications and games.
 * 
 * Scrapes DappRadar's trending and new dApps sections to find
 * emerging Web3 projects across multiple blockchains.
 * Focuses on DeFi, Gaming, and Utility categories.
 */
async function scrapeDappRadar() {
  const logger = createLogger('DappRadar');
  const proxyRotator = createProxyRotator();
  const startTime = Date.now();
  
  logger.info('Starting DappRadar scraper for new dApps and games');
  
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
    
    logger.info(`Using proxy: ${proxyData.proxy.id} for DappRadar scraping`);
    
    // Scrape multiple categories for better coverage
    const categories = [
      { name: 'DeFi', url: 'https://dappradar.com/rankings/category/defi' },
      { name: 'Games', url: 'https://dappradar.com/rankings/category/games' },
      { name: 'Exchanges', url: 'https://dappradar.com/rankings/category/exchanges' },
      { name: 'Marketplaces', url: 'https://dappradar.com/rankings/category/marketplaces' }
    ];
    
    for (const category of categories) {
      try {
        logger.info(`Scraping ${category.name} category from DappRadar`);
        const categoryResults = await scrapeDappRadarCategory(playHelper, category, logger);
        results.push(...categoryResults);
        stats.found += categoryResults.length;
      } catch (error) {
        logger.error(`Error scraping ${category.name} category:`, error);
        stats.errors++;
      }
    }
    
    // Process each dApp to get detailed information
    logger.info(`Found ${results.length} dApps across all categories. Getting detailed information...`);
    logger.startProgress('dapp-processing', results.length, 'Processing dApp details');
    
    const detailedResults = [];
    for (let i = 0; i < results.length; i++) {
      const dapp = results[i];
      
      try {
        logger.updateProgress('dapp-processing', i + 1, `${dapp.name}`);
        
        const detailedData = await scrapeDappDetails(playHelper, dapp, logger);
        if (detailedData) {
          // Apply filtering
          if (shouldIncludeDapp(detailedData, logger)) {
            detailedResults.push(detailedData);
            stats.processed++;
          } else {
            stats.filtered++;
          }
        }
        
        // Add delay between requests
        await playHelper.sleep(2000);
        
      } catch (error) {
        stats.errors++;
        logger.error(`Error processing dApp ${dapp.name}:`, error);
        continue;
      }
    }
    
    logger.completeProgress('dapp-processing', `${detailedResults.length} dApps processed successfully`);
    
    // Mark proxy as successful
    proxyRotator.markProxySuccess(proxyData.index, Date.now() - startTime);
    
    // Deduplicate results by domain before returning
    const uniqueResults = {};
    detailedResults.forEach(item => {
      if (item.domain && !uniqueResults[item.domain]) {
        uniqueResults[item.domain] = item;
      } else if (!item.domain && !uniqueResults[item.details_url]) { // Fallback for items without domain
        uniqueResults[item.details_url] = item;
      }
    });
    results.length = 0;
    results.push(...Object.values(uniqueResults));
    
  } catch (error) {
    logger.error('DappRadar scraper error:', error);
    stats.errors++;
  } finally {
    await playHelper.cleanup();
  }
  
  // Calculate final statistics
  stats.duration = Date.now() - startTime;
  stats.enriched = results.length;
  
  // Log comprehensive statistics
  logger.logStats(stats);
  
  // Log proxy statistics
  proxyRotator.logStats();
  
  logger.success(`DappRadar scraping completed: ${results.length} dApps extracted in ${(stats.duration / 1000).toFixed(1)}s`);
  
  return results;
}

/**
 * Scrape a specific category from DappRadar
 */
async function scrapeDappRadarCategory(playHelper, category, logger) {
  logger.info(`Loading ${category.name} category page`);
  
  await playHelper.navigateTo(category.url);
  
  const selectors = playHelper.getSelectors('dappradar');
  const { dappItems, dappLink, dappName, category: categorySelectors, description, blockchain, users } = selectors.selectors;

  // Wait for dApp list to load
  try {
    await playHelper.waitForElement(dappItems, { timeout: 30000 });
  } catch (e) {
    // Try alternative selector
    await playHelper.waitForElement(dappItems, { timeout: 30000 });
  }
  
  // Scroll down to load more projects if available
  await playHelper.scrollDownUntilNoNewContent(dappItems[0], 500, 5); // Scroll 5 times, 500ms delay

  // Extract dApp links from the category page
  const dapps = await playHelper.page.evaluate((categoryName, itemSelectors, linkSelectors, nameSelectors, catSelectors) => {
    const dappElements = document.querySelectorAll(itemSelectors.join(', '));
    const dapps = [];
    
    dappElements.forEach((element) => {
      const link = element.querySelector(linkSelectors.join(', '));
      const nameElement = element.querySelector(nameSelectors.join(', '));
      const categoryElement = element.querySelector(catSelectors.join(', '));
      
      if (link && nameElement) {
        const name = nameElement.textContent.trim();
        const url = link.href;
        const category = categoryElement ? categoryElement.textContent.trim() : categoryName;
        
        if (name && url && url.includes('dappradar.com/dapp/')) {
          dapps.push({
            name,
            url,
            category,
            source: 'DappRadar'
          });
        }
      }
    });
    
    return dapps;
  }, category.name, dappItems, dappLink, dappName, categorySelectors);
  
  logger.success(`Extracted ${dapps.length} dApps from ${category.name} category`);
  return dapps;
}

/**
 * Scrape detailed information for a specific dApp
 */
async function scrapeDappDetails(playHelper, dapp, logger) {
  try {
    logger.debug(`Getting details for ${dapp.name}`);
    
    await playHelper.navigateTo(dapp.url);
    
    const selectors = playHelper.getSelectors('dappradar');
    const { description: descSelectors, website: websiteSelectors, socialLinks: socialLinkSelectors, blockchain: blockchainSelectors, users: usersSelectors, volume: volumeSelectors } = selectors.selectors;

    // Extract detailed information
    const details = await playHelper.page.evaluate((descSelectors, websiteSelectors, socialLinkSelectors, blockchainSelectors, usersSelectors, volumeSelectors) => {
      const data = {
        description: null,
        website: null,
        twitter: null,
        discord: null,
        telegram: null,
        github: null,
        blockchain: null,
        users: null,
        volume: null,
        transactions: null
      };
      
      // Extract description
      for (const selector of descSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          data.description = element.textContent.trim();
          break;
        }
      }
      
      // Extract website
      for (const selector of websiteSelectors) {
        const element = document.querySelector(selector);
        if (element && element.href && !element.href.includes('dappradar.com')) {
          data.website = element.href;
          break;
        }
      }

      // Extract social links
      const socialLinks = document.querySelectorAll(socialLinkSelectors.join(', '));
      socialLinks.forEach(link => {
        const href = link.href.toLowerCase();
        
        if (href.includes('twitter.com') || href.includes('x.com')) {
          data.twitter = link.href;
        } else if (href.includes('discord')) {
          data.discord = link.href;
        } else if (href.includes('t.me') || href.includes('telegram')) {
          data.telegram = link.href;
        } else if (href.includes('github')) {
          data.github = link.href;
        }
      });
      
      // Extract blockchain information
      for (const selector of blockchainSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          data.blockchain = element.textContent.trim();
          break;
        }
      }
      
      // Extract metrics
      for (const selector of usersSelectors) {
        const userElement = document.querySelector(selector);
        if (userElement) {
          const userText = userElement.textContent.trim();
          const userMatch = userText.match(/([\d,]+)/);
          if (userMatch) {
            data.users = parseInt(userMatch[1].replace(/,/g, ''));
          }
          break;
        }
      }
      
      for (const selector of volumeSelectors) {
        const volumeElement = document.querySelector(selector);
        if (volumeElement) {
          data.volume = volumeElement.textContent.trim();
          break;
        }
      }
      
      return data;
    }, descSelectors, websiteSelectors, socialLinkSelectors, blockchainSelectors, usersSelectors, volumeSelectors);
    
    // Build complete project data in the required format
    const fullProjectData = {
      project_name: dapp.name,
      website: details.website || null,
      sale_type: 'DApp', // DappRadar lists dApps, not sales
      launchpad: 'N/A', // Not applicable for DappRadar
      category: dapp.category || 'DApp', // Use extracted category or default
      launch_date: null, // DappRadar doesn't consistently provide a launch date
      funding_raised: 'N/A', // Not available from DappRadar
      details_url: dapp.url,
      source: 'DappRadar'
    };

    // Validate critical fields
    if (!fullProjectData.project_name || !fullProjectData.website || !fullProjectData.details_url) {
      logger.debug(`Filtering out ${dapp.name}: missing critical fields (name, website, or details URL)`);
      return null;
    }
    
    // Extract domain if website is available for deduplication
    if (fullProjectData.website) {
      fullProjectData.domain = extractDomain(fullProjectData.website);
    }
    
    return fullProjectData;
    
  } catch (error) {
    logger.debug(`Failed to get details for ${dapp.name}: ${error.message}`);
    return null;
  }
}

/**
 * Filter function to determine if a dApp should be included
 */
function shouldIncludeDapp(dapp, logger) {
  // Must have a website for lead generation
  if (!dapp.website) {
    logger.debug(`Filtering out ${dapp.project_name}: no website found`);
    return false;
  }
  
  // Filter out low-quality or spam projects
  const name = dapp.project_name.toLowerCase();
  const description = (dapp.description || '').toLowerCase();
  
  // Skip obvious gambling/casino apps
  if (name.includes('casino') || name.includes('bet') || name.includes('lottery') ||
      description.includes('gambling') || description.includes('casino')) {
    logger.debug(`Filtering out gambling dApp: ${dapp.project_name}`);
    return false;
  }
  
  // Skip if no meaningful description
  if (!dapp.description || dapp.description.length < 50) {
    logger.debug(`Filtering out ${dapp.project_name}: insufficient description`);
    return false;
  }
  
  // Skip very low user count dApps (less than 10 users)
  if (dapp.users !== null && dapp.users < 10) {
    logger.debug(`Filtering out ${dapp.project_name}: too few users (${dapp.users})`);
    return false;
  }
  
  return true;
}

module.exports = { scrapeDappRadar };