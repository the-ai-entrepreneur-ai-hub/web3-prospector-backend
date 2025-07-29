const { PlaywrightHelper } = require('../utils/playwright-helper');
const { extractDomain } = require('../utils/dedup');
const { createLogger } = require('../utils/logger');
const { createProxyRotator } = require('../utils/proxy');

/**
 * Polkastarter scraper for cross-chain token sales and IDO projects.
 * 
 * Scrapes Polkastarter's project listings to find upcoming and active
 * token sales, IDOs, and launchpad projects across multiple blockchains.
 */
async function scrapePolkastarter() {
  const logger = createLogger('Polkastarter');
  const proxyRotator = createProxyRotator();
  const startTime = Date.now();
  
  logger.info('Starting Polkastarter scraper for IDO and token sale projects');
  
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
    
    logger.info(`Using proxy: ${proxyData.proxy.id}`);
    
    // Scrape multiple project sections
    const sections = [
      { name: 'Upcoming', url: 'https://polkastarter.com/projects?status=upcoming' },
      { name: 'Live', url: 'https://polkastarter.com/projects?status=live' },
      { name: 'Completed', url: 'https://polkastarter.com/projects?status=completed' }
    ];
    
    for (const section of sections) {
      try {
        logger.info(`Scraping ${section.name} section`);
        const sectionResults = await scrapePolkastarterSection(playHelper, section, logger);
        results.push(...sectionResults);
        stats.found += sectionResults.length;
        
        // Rate limiting
        await playHelper.sleep(2000);
        
      } catch (error) {
        logger.error(`Error scraping ${section.name}:`, error);
        stats.errors++;
        continue;
      }
    }
    
    // Process project details
    logger.info(`Found ${results.length} projects. Getting detailed information...`);
    logger.startProgress('project-processing', Math.min(results.length, 40), 'Processing project details');
    
    const detailedResults = [];
    const maxProjects = Math.min(results.length, 40); // Limit for production reliability
    
    for (let i = 0; i < maxProjects; i++) {
      const project = results[i];
      
      try {
        logger.updateProgress('project-processing', i + 1, `${project.name}`);
        
        const detailedData = await scrapePolkastarterProjectDetails(playHelper, project, logger);
        if (detailedData) {
          // Apply filtering
          if (shouldIncludePolkastarterProject(detailedData, logger)) {
            detailedResults.push(detailedData);
            stats.processed++;
          } else {
            stats.filtered++;
          }
        }
        
        // Rate limiting between requests
        await playHelper.sleep(1500);
        
      } catch (error) {
        logger.error(`Error processing ${project.name}:`, error);
        stats.errors++;
        continue;
      }
    }
    
    logger.completeProgress('project-processing', `${detailedResults.length} projects processed successfully`);
    
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
    logger.error('Polkastarter scraper error:', error);
    stats.errors++;
  } finally {
    await playHelper.cleanup();
  }
  
  // Final statistics
  stats.duration = Date.now() - startTime;
  
  logger.info('=== POLKASTARTER SCRAPING STATISTICS ===');
  logger.info(`Projects Found: ${stats.found}`);
  logger.info(`Projects Processed: ${stats.processed}`);
  logger.info(`Projects Filtered: ${stats.filtered}`);
  logger.info(`Errors: ${stats.errors}`);
  logger.info(`Duration: ${(stats.duration / 1000).toFixed(1)}s`);
  logger.info(`Success Rate: ${stats.found > 0 ? ((stats.processed / stats.found) * 100).toFixed(1) : '0.0'}%`);
  
  logger.success(`Polkastarter scraping completed: ${results.length} projects extracted`);
  
  return results;
}

/**
 * Scrape a specific section from Polkastarter
 */
async function scrapePolkastarterSection(playHelper, section, logger) {
  logger.info(`Loading ${section.name} section`);
  
  await playHelper.navigateTo(section.url);
  
  // Wait for project list to load
  const selectors = playHelper.getSelectors('polkastarter');
  const { projectCards, projectName } = selectors.selectors;
  
  await playHelper.waitForElement(projectCards, { timeout: 30000 });
  
  // Handle potential infinite scroll
  await playHelper.scrollDownUntilNoNewContent(projectCards[0], 500, 5); // Scroll 5 times, 500ms delay

  // Extract project URLs
  const projectUrls = await playHelper.page.evaluate((cardSelectors, nameSelectors) => {
    const projects = [];
    const containers = document.querySelectorAll(cardSelectors.join(', '));
    
    containers.forEach((container) => {
      const linkElement = container.querySelector('a[href*="/project"], a[href*="/pool"]');
      if (linkElement && linkElement.href) {
        const nameElement = container.querySelector(nameSelectors.join(', '));
        const name = nameElement ? nameElement.textContent.trim() : 'Unknown Project';
        
        projects.push({
          name,
          url: linkElement.href,
          source: 'Polkastarter'
        });
      }
    });
    
    return projects;
  }, projectCards, projectName);
  
  logger.success(`Extracted ${projectUrls.length} projects from ${section.name}`);
  return projectUrls;
}

/**
 * Scrape detailed information for a specific project
 */
async function scrapePolkastarterProjectDetails(playHelper, project, logger) {
  try {
    logger.debug(`Getting details for ${project.name}`);
    
    await playHelper.navigateTo(project.url);
    
    const selectors = playHelper.getSelectors('polkastarter');
    const { description: descSelectors, category: categorySelectors, website: websiteSelectors, socialLinks: socialLinkSelectors, tokenInfo: tokenInfoSelectors } = selectors.selectors;

    // Extract comprehensive project data
    const projectData = await playHelper.page.evaluate((descSelectors, categorySelectors, websiteSelectors, socialLinkSelectors, tokenInfoSelectors) => {
      const data = {
        description: null,
        category: null,
        website: null,
        saleDate: null,
        socialLinks: {},
        tokenSymbol: null,
        totalRaise: null,
        launchDate: null
      };
      
      // Extract description
      for (const selector of descSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent.trim().length > 50) {
          data.description = element.textContent.trim();
          break;
        }
      }
      
      // Extract category
      for (const selector of categorySelectors) {
        const element = document.querySelector(selector);
        if (element) {
          data.category = element.textContent.trim();
          break;
        }
      }
      
      // Extract website
      for (const selector of websiteSelectors) {
        const element = document.querySelector(selector);
        if (element && element.href && !element.href.includes('polkastarter.com')) {
          data.website = element.href;
          break;
        }
      }

      // Extract all social links
      const linkElements = document.querySelectorAll(socialLinkSelectors.join(', '));
      linkElements.forEach(link => {
        const href = link.href.toLowerCase();
        
        if (href.includes('twitter.com') || href.includes('x.com')) {
          data.socialLinks.twitter = link.href;
        } else if (href.includes('t.me') || href.includes('telegram')) {
          data.socialLinks.telegram = link.href;
        } else if (href.includes('discord')) {
          data.socialLinks.discord = link.href;
        } else if (href.includes('github')) {
          data.socialLinks.github = link.href;
        } else if (href.includes('medium.com')) {
          data.socialLinks.medium = link.href;
        }
      });

      // Extract token info (symbol, raise, launch date)
      for (const selector of tokenInfoSelectors) {
        const container = document.querySelector(selector);
        if (container) {
          const text = container.textContent;
          const symbolMatch = text.match(/Token Symbol:\s*([A-Z0-9]+)/i);
          if (symbolMatch) data.tokenSymbol = symbolMatch[1];

          const raiseMatch = text.match(/(Total Raise|Funds Raised):\s*([\d,\.$]+)/i);
          if (raiseMatch) data.totalRaise = raiseMatch[2];

          const dateMatch = text.match(/(Launch Date|Sale Date):\s*([\w\s,]+)/i);
          if (dateMatch) data.launchDate = dateMatch[2];
          break;
        }
      }
      
      return data;
    }, descSelectors, categorySelectors, websiteSelectors, socialLinkSelectors, tokenInfoSelectors);
    
    // Build complete project data in the required format
    const fullProjectData = {
      project_name: project.name,
      website: projectData.website || null,
      sale_type: project.section === 'Upcoming' ? 'Upcoming IDO' : (project.section === 'Live' ? 'Live IDO' : 'Completed IDO'),
      launchpad: 'Polkastarter',
      category: projectData.category || 'Blockchain', // Default category if not found
      launch_date: projectData.launchDate || null,
      funding_raised: projectData.totalRaise || 'N/A',
      details_url: project.url,
      source: 'Polkastarter'
    };

    // Validate critical fields
    if (!fullProjectData.project_name || !fullProjectData.website || !fullProjectData.details_url) {
      logger.debug(`Filtering out ${project.name}: missing critical fields (name, website, or details URL)`);
      return null;
    }
    
    // Extract domain if website available for deduplication
    if (fullProjectData.website) {
      fullProjectData.domain = extractDomain(fullProjectData.website);
    }
    
    return fullProjectData;
    
  } catch (error) {
    logger.debug(`Failed to get details for ${project.name}: ${error.message}`);
    return null;
  }
}

/**
 * Filter function to determine if a project should be included
 */
function shouldIncludePolkastarterProject(project, logger) {
  // Must have website for lead generation
  if (!project.website) {
    logger.debug(`Filtering out ${project.project_name}: no website found`);
    return false;
  }
  
  // Filter out obvious meme/spam projects
  const name = project.project_name.toLowerCase();
  const description = (project.description || '').toLowerCase();
  
  if (name.includes('meme') || name.includes('doge') || name.includes('shib') ||
      description.includes('meme') || description.includes('pump')) {
    logger.debug(`Filtering out potential meme project: ${project.project_name}`);
    return false;
  }
  
  return true;
}

module.exports = { scrapePolkastarter };