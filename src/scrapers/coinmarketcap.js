const { PlaywrightHelper } = require('../utils/playwright-helper');
const { extractDomain } = require('../utils/dedup');
const { createLogger } = require('../utils/logger');
const { createProxyRotator } = require('../utils/proxy');

/**
 * Enhanced CoinMarketCap scraper using Playwright with stealth mode.
 * 
 * Scrapes the CoinMarketCap "new" section to find recently added tokens
 * and extracts their social links and website information.
 * Uses the __NEXT_DATA__ approach with robust error handling and monitoring.
 */
async function scrapeCoinMarketCap() {
  const logger = createLogger('CoinMarketCap');
  const proxyRotator = createProxyRotator();
  const startTime = Date.now();
  
  logger.info('Starting enhanced CoinMarketCap scraper with Playwright');
  
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
    
    logger.info(`Using proxy: ${proxyData.proxy.id} for scraping session`);
    
    // Navigate to new cryptocurrencies page
    logger.info('Navigating to CoinMarketCap new cryptocurrencies page');
    await playHelper.navigateTo('https://coinmarketcap.com/new/');
    
    // Wait for the page to be fully loaded
    await playHelper.page.waitForLoadState('networkidle');

    // Wait for the __NEXT_DATA__ script to load
    const nextDataSelector = 'script#__NEXT_DATA__';
    logger.debug('Waiting for __NEXT_DATA__ script to load');
    try {
        await playHelper.waitForElement([nextDataSelector], { timeout: 60000 });
    } catch (error) {
        logger.error('Could not find __NEXT_DATA__ script. Taking a screenshot.');
        await playHelper.page.screenshot({ path: 'coinmarketcap-error.png' });
        throw new Error('Could not find __NEXT_DATA__ script.');
    }
    
    logger.info('Extracting coin data from __NEXT_DATA__');
    
    // Extract coin list from __NEXT_DATA__
    const pageData = await playHelper.page.evaluate(() => {
      const scriptElement = document.querySelector('script#__NEXT_DATA__');
      if (scriptElement && scriptElement.textContent) {
        try {
          return JSON.parse(scriptElement.textContent);
        } catch (e) {
          console.error('Failed to parse __NEXT_DATA__ from script:', e);
        }
      }
      // Fallback to window object
      if (window.__NEXT_DATA__) {
        return window.__NEXT_DATA__;
      }
      return null;
    });
    
    if (!pageData || !pageData.props || !pageData.props.pageProps) {
      throw new Error('Could not extract page data from __NEXT_DATA__');
    }
    
    const coins = pageData.props.pageProps.data?.data?.recentlyAddedList;
    
    if (!coins || coins.length === 0) {
      throw new Error('Could not find coin list in page data');
    }
    
    stats.found = coins.length;
    logger.success(`Found ${coins.length} new coins in the data`);
    
    // Process more coins with better limits (60 instead of 50)
    const maxCoins = Math.min(coins.length, 60);
    const coinsToProcess = coins.slice(0, maxCoins);
    
    logger.info(`Processing ${coinsToProcess.length} coins (limited from ${coins.length} total)`);
    logger.startProgress('coin-processing', coinsToProcess.length, 'Processing coin details');
    
    for (let i = 0; i < coinsToProcess.length; i++) {
      const coin = coinsToProcess[i];
      
      try {
        logger.updateProgress('coin-processing', i + 1, `${coin.name} (${coin.symbol})`);
        
        // Construct detail page URL
        const detailUrl = `https://coinmarketcap.com/currencies/${coin.slug}/`;
        
        await playHelper.navigateTo(detailUrl);
        
        // Wait for __NEXT_DATA__ on detail page
        await playHelper.waitForElement([nextDataSelector], { timeout: 15000 });
        
        // Extract social links from detail page using robust method
        const detailData = await playHelper.page.evaluate(() => {
          const scriptElement = document.querySelector('script#__NEXT_DATA__');
          if (!scriptElement) return {};
          
          try {
            const data = JSON.parse(scriptElement.textContent);
            const urls = data?.props?.pageProps?.detailRes?.detail?.urls;
            
            const socials = {};
            if (urls) {
              if (urls.website && urls.website.length > 0) socials.website = urls.website[0];
              if (urls.twitter && urls.twitter.length > 0) socials.twitter = urls.twitter[0];
              if (urls.source_code && urls.source_code.length > 0) socials.github = urls.source_code[0];
              
              if (urls.chat && urls.chat.length > 0) {
                urls.chat.forEach(link => {
                  if (link.includes('discord')) socials.discord = link;
                  else if (link.includes('t.me')) socials.telegram = link;
                  else if (link.includes('youtube')) socials.youtube = link;
                });
              }
              
              // Additional social extraction
              if (urls.message_board && urls.message_board.length > 0) {
                urls.message_board.forEach(link => {
                  if (link.includes('reddit')) socials.reddit = link;
                  else if (link.includes('medium')) socials.medium = link;
                });
              }
            }
            
            return socials;
          } catch (e) {
            console.error('Failed to parse detail page data:', e);
            return {};
          }
        });
        
        // Build comprehensive project data in the required format
        const projectData = {
          project_name: coin.name,
          website: detailData?.website || null,
          sale_type: 'N/A', // CoinMarketCap lists cryptocurrencies, not sales
          launchpad: 'N/A', // Not applicable for CoinMarketCap
          category: projectData.category || 'Cryptocurrency', // Use extracted category or default
          launch_date: coin.date_added || null,
          funding_raised: 'N/A', // Not available from CoinMarketCap for new listings
          details_url: detailUrl,
          source: 'CoinMarketCap'
        };
        
        // Validate critical fields
        if (!projectData.project_name || !projectData.website || !projectData.launch_date) {
          logger.debug(`Filtering out ${coin.name}: missing critical fields (name, website, or launch date)`);
          stats.filtered++;
          continue;
        }

        // Deduplicate by normalized domain
        if (projectData.website) {
          projectData.domain = extractDomain(projectData.website);
        }
        
        // Enhanced filtering logic (existing)
        if (!projectData.website && !detailData.twitter && !detailData.telegram) { // Use detailData for social presence check
          logger.debug(`Filtering out ${coin.name}: no website or social presence`);
          stats.filtered++;
          continue;
        }
        
        // Filter out obvious meme coins or low-quality projects (existing)
        const name = projectData.project_name.toLowerCase();
        const symbol = coin.symbol.toLowerCase(); // Use original coin.symbol for filtering
        
        if (name.includes('doge') || name.includes('shib') || name.includes('pepe') ||
            name.includes('meme') || name.includes('inu') || symbol.includes('meme') ||
            name.includes('baby') || name.includes('moon') || name.includes('safe')) {
          logger.debug(`Filtering out potential meme coin: ${projectData.project_name}`);
          stats.filtered++;
          continue;
        }
        
        // Filter out very low market cap coins (likely spam) (existing)
        if (coin.quote?.USD?.market_cap && coin.quote.USD.market_cap < 100000) {
          logger.debug(`Filtering out low market cap coin: ${projectData.project_name} (${coin.quote.USD.market_cap})`);
          stats.filtered++;
          continue;
        }
        
        results.push(projectData);
        stats.processed++;
        logger.debug(`✓ Extracted: ${projectData.project_name} - ${projectData.website || 'No website'}`);
        
        // Rate limiting with variable delay
        await playHelper.sleep(1200 + Math.random() * 800);
        
      } catch (error) {
        stats.errors++;
        logger.error(`Error processing ${coin.name}: ${error.message}`);
        continue;
      }
    }
    
    logger.completeProgress('coin-processing', `${results.length} projects extracted successfully`);
    
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
    logger.error('CoinMarketCap scraper error:', error);
    stats.errors++;
  } finally {
    await playHelper.cleanup();
  }
  
  // Calculate final statistics
  stats.duration = Date.now() - startTime;
  stats.enriched = results.length; // Renamed from enriched to processed for consistency
  
  // Log comprehensive statistics
  logger.info('=== COINMARKETCAP SCRAPING STATISTICS ===');
  logger.info(`Coins Found: ${stats.found}`);
  logger.info(`Coins Processed: ${stats.processed}`);
  logger.info(`Coins Filtered: ${stats.filtered}`);
  logger.info(`Errors: ${stats.errors}`);
  logger.info(`Duration: ${(stats.duration / 1000).toFixed(1)}s`);
  logger.info(`Success Rate: ${stats.found > 0 ? ((stats.processed / stats.found) * 100).toFixed(1) : '0.0'}%`);
  
  // Log proxy statistics
  proxyRotator.logStats();
  
  logger.success(`CoinMarketCap scraping completed: ${results.length} projects extracted in ${(stats.duration / 1000).toFixed(1)}s`);
  
  return results;
}

module.exports = { scrapeCoinMarketCap };