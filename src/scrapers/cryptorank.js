const { PlaywrightHelper } = require('../utils/playwright-helper');
const { extractDomain } = require('../utils/dedup');
const { createLogger } = require('../utils/logger');
const { createProxyRotator } = require('../utils/proxy');

/**
 * Production CryptoRank scraper using Playwright
 * 
 * Scrapes live ICO and token sale data from CryptoRank including:
 * - Upcoming token sales
 * - Active ICOs
 * - Project details and social links
 * - Funding information
 */
async function scrapeCryptoRank() {
  const logger = createLogger('CryptoRank');
  const proxyRotator = createProxyRotator();
  const startTime = Date.now();
  
  logger.info('Starting CryptoRank scraper with Playwright');
  
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
    
    // Scrape multiple sections
    const sections = [
      { name: 'Upcoming ICOs', url: 'https://cryptorank.io/ico?status=upcoming' },
      { name: 'Active ICOs', url: 'https://cryptorank.io/ico?status=active' },
      { name: 'Token Sales', url: 'https://cryptorank.io/ico' }
    ];
    
    for (const section of sections) {
      try {
        logger.info(`Scraping ${section.name} section`);
        const sectionResults = await scrapeCryptoRankSection(playHelper, section, logger);
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
    logger.startProgress('project-processing', Math.min(results.length, 50), 'Processing project details');
    
    const detailedResults = [];
    const maxProjects = Math.min(results.length, 50); // Limit for production reliability
    
    for (let i = 0; i < maxProjects; i++) {
      const project = results[i];
      
      try {
        logger.updateProgress('project-processing', i + 1, `${project.name}`);
        
        const detailedData = await scrapeProjectDetails(playHelper, project, logger);
        if (detailedData && shouldIncludeProject(detailedData, logger)) {
          detailedResults.push(detailedData);
          stats.processed++;
        } else {
          stats.filtered++;
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
    
    results.length = 0;
    results.push(...detailedResults);
    
  } catch (error) {
    logger.error('CryptoRank scraper error:', error);
    stats.errors++;
  } finally {
    await playHelper.cleanup();
  }
  
  // Final statistics
  stats.duration = Date.now() - startTime;
  
  logger.info('=== CRYPTORANK SCRAPING STATISTICS ===');
  logger.info(`Projects Found: ${stats.found}`);
  logger.info(`Projects Processed: ${stats.processed}`);
  logger.info(`Projects Filtered: ${stats.filtered}`);
  logger.info(`Errors: ${stats.errors}`);
  logger.info(`Duration: ${(stats.duration / 1000).toFixed(1)}s`);
  logger.info(`Success Rate: ${stats.found > 0 ? ((stats.processed / stats.found) * 100).toFixed(1) : '0.0'}%`);
  
  logger.success(`CryptoRank scraping completed: ${results.length} projects extracted`);
  
  return results;
}

/**
 * Scrape a specific section from CryptoRank
 */
async function scrapeCryptoRankSection(playHelper, section, logger) {
  logger.info(`Loading ${section.name}`);
  
  await playHelper.navigateTo(section.url);
  
  // Wait for project list to load
  const selectors = playHelper.getSelectors('cryptorank');
  const { projectList, projectLink, projectName } = selectors.selectors;
  await playHelper.waitForElement(projectList, { timeout: 30000 });
  
  // Extract project URLs
  const projectUrls = await playHelper.page.evaluate((listSelectors, linkSelectors, nameSelectors) => {
    const projects = [];
    const containers = document.querySelectorAll(listSelectors.join(', '));
    
    containers.forEach((container, index) => {
      if (index >= 30) return; // Limit per section
      
      const linkElement = container.querySelector(linkSelectors.join(', '));
      if (linkElement && linkElement.href) {
        const nameElement = container.querySelector(nameSelectors.join(', '));
        const name = nameElement ? nameElement.textContent.trim() : 'Unknown Project';
        
        projects.push({
          name,
          url: linkElement.href,
          source: 'CryptoRank'
        });
      }
    });
    
    return projects;
  }, projectList, projectLink, projectName);
  
  logger.success(`Extracted ${projectUrls.length} projects from ${section.name}`);
  return projectUrls;
}

/**
 * Scrape detailed information for a specific project
 */
async function scrapeProjectDetails(playHelper, project, logger) {
  try {
    logger.debug(`Getting details for ${project.name}`);
    
    await playHelper.navigateTo(project.url);
    
    const selectors = playHelper.getSelectors('cryptorank');
    const { projectDescription, category, saleDate, socialLinks, website } = selectors.selectors;
    
    // Extract comprehensive project data
    const projectData = await playHelper.page.evaluate((descSelectors, categorySelectors, dateSelectors, socialLinkSelectors, websiteSelectors) => {
      const data = {
        description: null,
        category: null,
        website: null,
        saleDate: null,
        socialLinks: {}
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
      
      // Extract sale date
      for (const selector of dateSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          data.saleDate = element.textContent.trim();
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

      // Extract website specifically
      for (const selector of websiteSelectors) {
        const element = document.querySelector(selector);
        if (element && element.href && !element.href.includes('cryptorank.io')) {
          data.website = element.href;
          break;
        }
      }
      
      return data;
    }, projectDescription, category, saleDate, socialLinks, website);
    
    // Build complete project data in the required format
    const fullProjectData = {
      project_name: project.name,
      website: projectData.website || null,
      sale_type: section.name.includes('Upcoming') ? 'Upcoming ICO' : (section.name.includes('Active') ? 'Active ICO' : 'Token Sale'),
      launchpad: 'CryptoRank', // Source is the launchpad for CryptoRank
      category: projectData.category || 'Blockchain', // Default category if not found
      launch_date: projectData.saleDate || null,
      funding_raised: 'N/A', // CryptoRank doesn't consistently provide this on listing pages
      details_url: project.url,
      source: 'CryptoRank'
    };
    
    // Validate critical fields
    if (!fullProjectData.project_name || !fullProjectData.website || !fullProjectData.launch_date) {
      logger.debug(`Filtering out ${project.name}: missing critical fields (name, website, or launch date)`);
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
function shouldIncludeProject(project, logger) {
  // Must have meaningful description (if available, otherwise rely on other fields)
  // CryptoRank doesn't always have a description on the main listing, so relax this.
  // if (!project.description || project.description.length < 100) {
  //   logger.debug(`Filtering out ${project.name}: insufficient description`);
  //   return false;
  // }
  
  // Must have website or strong social presence
  if (!project.website && !project.twitter && !project.telegram) {
    logger.debug(`Filtering out ${project.project_name}: no web presence`);
    return false;
  }
  
  // Filter out obvious meme/spam projects
  const name = project.project_name.toLowerCase();
  // const description = project.description ? project.description.toLowerCase() : ''; // Description might be null
  
  if (name.includes('meme') || name.includes('doge') || name.includes('shib') ||
      // description.includes('meme') || description.includes('pump') ||
      name.includes('baby') || name.includes('moon') || name.includes('safe')) {
    logger.debug(`Filtering out potential meme/spam project: ${name}`);
    return false;
  }
  
  return true;
}

module.exports = { scrapeCryptoRank };