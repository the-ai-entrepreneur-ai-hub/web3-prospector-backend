const { PlaywrightHelper } = require('../utils/playwright-helper');
const { extractDomain } = require('../utils/dedup');
const { createLogger } = require('../utils/logger');
const { createProxyRotator } = require('../utils/proxy');

/**
 * DAO Maker scraper for token sales and IDO projects.
 * 
 * Scrapes DAO Maker's upcoming and active project listings to find
 * new token sales, IDOs, and funding rounds. Focuses on high-quality
 * projects with detailed information and social presence.
 */
async function scrapeDAOMaker() {
  console.log("Starting DAO Maker scraper execution..."); // Added for debugging
  const logger = createLogger('DAOMaker');
  const proxyRotator = createProxyRotator();
  const startTime = Date.now();
  
  logger.info('Starting DAO Maker scraper for IDO and token sale projects');
  
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
    
    logger.info(`Using proxy: ${proxyData.proxy.id} for DAO Maker scraping`);
    
    // Scrape multiple project sections
    const sections = [
      { name: 'Upcoming', url: 'https://app.daomaker.com/projects?status=upcoming' },
      { name: 'Active', url: 'https://app.daomaker.com/projects?status=active' },
      { name: 'Completed', url: 'https://app.daomaker.com/projects?status=completed' }
    ];
    
    for (const section of sections) {
      try {
        logger.info(`Scraping ${section.name} projects from DAO Maker`);
        const sectionResults = await scrapeDAOMakerSection(playHelper, section, logger);
        results.push(...sectionResults);
        stats.found += sectionResults.length;
        
        // Add delay between sections
        await playHelper.sleep(3000);
        
      } catch (error) {
        logger.error(`Error scraping ${section.name} section:`, error);
        stats.errors++;
        continue;
      }
    }
    
    // Process each project to get detailed information
    logger.info(`Found ${results.length} projects across all sections. Getting detailed information...`);
    logger.startProgress('project-processing', results.length, 'Processing project details');
    
    const detailedResults = [];
    for (let i = 0; i < results.length; i++) {
      const project = results[i];
      
      try {
        logger.updateProgress('project-processing', i + 1, `${project.name}`);
        
        const detailedData = await scrapeProjectDetails(playHelper, project, logger);
        if (detailedData) {
          // Apply filtering
          if (shouldIncludeProject(detailedData, logger)) {
            detailedResults.push(detailedData);
            stats.processed++;
          } else {
            stats.filtered++;
          }
        }
        
        // Add delay between requests
        await playHelper.sleep(2500);
        
      } catch (error) {
        stats.errors++;
        logger.error(`Error processing project ${project.name}:`, error);
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
    logger.error('DAO Maker scraper error:', error);
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
  
  logger.success(`DAO Maker scraping completed: ${results.length} projects extracted in ${(stats.duration / 1000).toFixed(1)}s`);

  console.log("DAO Maker scraper execution finished."); // Added for debugging
  return results;
}

/**
 * Scrape a specific section from DAO Maker
 */
async function scrapeDAOMakerSection(playHelper, section, logger) {
  logger.info(`Loading ${section.name} section`);
  
  await playHelper.navigateTo(section.url);
  
  // Wait for the page to load and handle SPA behavior
  await playHelper.sleep(3000);
  
  // Wait for content with multiple strategies
  let contentLoaded = false;
  const loadingAttempts = [
    // Try waiting for project cards
    async () => await playHelper.waitForElement(['.card', '.project-card'], { timeout: 15000 }),
    // Try waiting for any content structure
    async () => await playHelper.waitForElement(['main', '[role="main"]', '.content'], { timeout: 15000 }),
    // Try waiting for Next.js content
    async () => await playHelper.waitForElement(['#__next', '[data-reactroot]'], { timeout: 15000 })
  ];

  for (const attempt of loadingAttempts) {
    try {
      await attempt();
      contentLoaded = true;
      logger.info('Content loaded successfully');
      break;
    } catch (e) {
      logger.debug(`Loading attempt failed: ${e.message}`);
      continue;
    }
  }

  if (!contentLoaded) {
    logger.warn('Could not detect content loading, proceeding anyway');
  }
  
  // Additional wait for dynamic content
  await playHelper.sleep(2000);
  
  // Scroll down to load more projects if available
  await playHelper.scrollDownUntilNoNewContent(['.card', '.project-card'], 1000, 3);

  // Extract project information with improved strategies
  const projects = await playHelper.page.evaluate((sectionName) => {
    const projects = [];
    
    // Strategy 1: Look for cards
    const cardElements = document.querySelectorAll('.card, .project-card, [class*="card"]');
    
    cardElements.forEach((element) => {
      let link = element.querySelector('a') || (element.tagName === 'A' ? element : null);
      
      // Look for links that might contain project URLs
      if (!link) {
        link = element.querySelector('a[href*="/projects/"], a[href*="/project/"]');
      }
      
      if (link && link.href && (link.href.includes('/projects/') || link.href.includes('/project/'))) {
        // Extract project name from various locations
        let name = null;
        
        // Try to find name in common locations
        const nameSelectors = [
          'h3', 'h4', 'h2', '.project-name', '.title', '.card-title',
          '[class*="name"]', '[class*="title"]'
        ];
        
        for (const selector of nameSelectors) {
          const nameElement = element.querySelector(selector);
          if (nameElement && nameElement.textContent.trim()) {
            name = nameElement.textContent.trim();
            break;
          }
        }
        
        // Fallback: extract from URL
        if (!name) {
          const urlParts = link.href.split('/projects/')[1] || link.href.split('/project/')[1];
          if (urlParts) {
            name = urlParts.split('?')[0].split('/')[0].replace(/-/g, ' ').replace(/_/g, ' ');
            name = name.charAt(0).toUpperCase() + name.slice(1);
          }
        }
        
        // Extract status/stage information
        let status = sectionName;
        const statusElements = element.querySelectorAll('.status, .stage, .badge, [class*="status"], [class*="stage"]');
        statusElements.forEach(statusEl => {
          if (statusEl.textContent.trim()) {
            status = statusEl.textContent.trim();
          }
        });
        
        // Extract description if available
        let description = null;
        const descElements = element.querySelectorAll('p, .description, [class*="description"]');
        descElements.forEach(descEl => {
          if (descEl.textContent.trim().length > 20) {
            description = descEl.textContent.trim();
          }
        });
        
        if (name && link.href) {
          projects.push({
            name,
            url: link.href,
            status,
            description,
            source: 'DAOMaker',
            section: sectionName
          });
        }
      }
    });
    
    // Strategy 2: Look for any project links if no cards found
    if (projects.length === 0) {
      const allLinks = document.querySelectorAll('a[href*="/projects/"], a[href*="/project/"]');
      
      allLinks.forEach((link, index) => {
        if (index >= 20) return; // Limit to avoid too many results
        
        let name = link.textContent.trim();
        if (!name) {
          const urlParts = link.href.split('/projects/')[1] || link.href.split('/project/')[1];
          if (urlParts) {
            name = urlParts.split('?')[0].split('/')[0].replace(/-/g, ' ').replace(/_/g, ' ');
            name = name.charAt(0).toUpperCase() + name.slice(1);
          }
        }
        
        if (name && name.length > 2) {
          projects.push({
            name,
            url: link.href,
            status: sectionName,
            description: null,
            source: 'DAOMaker',
            section: sectionName
          });
        }
      });
    }
    
    // Remove duplicates
    const uniqueProjects = [];
    const seenUrls = new Set();
    projects.forEach(project => {
      if (!seenUrls.has(project.url)) {
        seenUrls.add(project.url);
        uniqueProjects.push(project);
      }
    });
    
    return uniqueProjects;
  }, section.name);
  
  logger.success(`Extracted ${projects.length} projects from ${section.name} section`);
  return projects;
}

/**
 * Scrape detailed information for a specific project
 */
async function scrapeProjectDetails(playHelper, project, logger) {
  try {
    logger.debug(`Getting details for ${project.name}`);
    
    await playHelper.navigateTo(project.url);
    
    // Wait for page to load
    await playHelper.sleep(3000);
    
    // Extract detailed information with improved logic
    const details = await playHelper.page.evaluate(() => {
      const data = {
        description: null,
        website: null,
        twitter: null,
        discord: null,
        telegram: null,
        github: null,
        linkedin: null,
        medium: null,
        whitepaper: null,
        category: null,
        tokenSymbol: null,
        totalRaise: null,
        participants: null,
        blockchain: null
      };
      
      // Extract description from multiple possible locations
      const descriptionSelectors = [
        '.project-description',
        '.description',
        '.about-project',
        '[data-testid="project-description"]',
        '.overview-text',
        '.project-overview',
        '.summary',
        'section p',
        '.content p',
        'p'
      ];
      
      for (const selector of descriptionSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent.trim().length > 50) {
          data.description = element.textContent.trim();
          break;
        }
      }
      
      // Extract all links and categorize them
      const allLinks = document.querySelectorAll('a[href]');
      
      allLinks.forEach(link => {
        if (!link.href) return;
        
        const url = link.href.toLowerCase();
        const text = (link.textContent || link.title || '').toLowerCase();
        
        // Get text from child elements too
        const childText = Array.from(link.querySelectorAll('*'))
          .map(el => el.textContent || '')
          .join(' ')
          .toLowerCase();
        
        const fullText = `${text} ${childText}`.trim();
        
        // Categorize links by domain and content
        if (fullText.includes('twitter') || url.includes('twitter.com') || url.includes('x.com')) {
          data.twitter = link.href;
        } else if (fullText.includes('discord') || url.includes('discord')) {
          data.discord = link.href;
        } else if (fullText.includes('telegram') || url.includes('t.me')) {
          data.telegram = link.href;
        } else if (fullText.includes('github') || url.includes('github')) {
          data.github = link.href;
        } else if (fullText.includes('linkedin') || url.includes('linkedin')) {
          data.linkedin = link.href;
        } else if (fullText.includes('medium') || url.includes('medium.com')) {
          data.medium = link.href;
        } else if (fullText.includes('whitepaper') || fullText.includes('white paper')) {
          data.whitepaper = link.href;
        } else if ((fullText.includes('website') || fullText.includes('visit') || fullText.includes('official')) && 
                   !data.website && 
                   !url.includes('daomaker.com') && 
                   !url.includes('twitter') && 
                   !url.includes('telegram') && 
                   !url.includes('discord') && 
                   !url.includes('github') &&
                   !url.includes('medium') &&
                   !url.includes('linkedin') &&
                   url.startsWith('http')) {
          data.website = link.href;
        }
      });
      
      // If no website found, try to find any external link that looks like a main website
      if (!data.website) {
        allLinks.forEach(link => {
          const url = link.href.toLowerCase();
          if (url.startsWith('http') && 
              !url.includes('daomaker.com') && 
              !url.includes('twitter') && 
              !url.includes('telegram') && 
              !url.includes('discord') && 
              !url.includes('github') &&
              !url.includes('medium') &&
              !url.includes('linkedin') &&
              !url.includes('reddit') &&
              !url.includes('coinmarketcap') && 
              !url.includes('coingecko') &&
              !url.includes('etherscan') &&
              !url.includes('bscscan')) {
            // This looks like it could be the main website
            data.website = link.href;
            return; // Break out of forEach
          }
        });
      }

      // Extract project metadata from various possible locations
      const metadataContainers = document.querySelectorAll('.project-info, .project-details, .token-info, [data-testid="project-meta"], .project-stats, .info-item, .detail-item, .stat-item');
      
      metadataContainers.forEach(container => {
        const items = container.querySelectorAll('dt, dd, .label, .value, div, span, p');
        
        items.forEach((item, index) => {
          const text = item.textContent.trim().toLowerCase();
          const nextItem = items[index + 1];
          const value = nextItem ? nextItem.textContent.trim() : '';
          
          if ((text.includes('category') || text.includes('sector')) && (value || item.textContent.trim())) {
            data.category = value || item.textContent.trim();
          } else if ((text.includes('symbol') || text.includes('token')) && (value || item.textContent.trim())) {
            data.tokenSymbol = value || item.textContent.trim();
          } else if ((text.includes('raise') || text.includes('target') || text.includes('funding')) && (value || item.textContent.trim())) {
            data.totalRaise = value || item.textContent.trim();
          } else if ((text.includes('blockchain') || text.includes('network') || text.includes('chain')) && (value || item.textContent.trim())) {
            data.blockchain = value || item.textContent.trim();
          }
        });
      });
      
      return data;
    });
    
    // Build complete project data in the required format
    const fullProjectData = {
      project_name: project.name,
      website: details.website || null,
      sale_type: project.section === 'Upcoming' ? 'Upcoming IDO' : (project.section === 'Active' ? 'Active IDO' : 'Completed IDO'),
      launchpad: 'DAOMaker',
      category: details.category || 'Blockchain', // Default category if not found
      launch_date: null, // DAO Maker doesn't consistently provide a single launch date on listing pages
      funding_raised: details.totalRaise || 'N/A',
      details_url: project.url,
      source: 'DAOMaker'
    };

    // Add additional context data
    if (details.description) fullProjectData.description = details.description;
    if (details.blockchain) fullProjectData.blockchain = details.blockchain;
    if (details.tokenSymbol) fullProjectData.tokenSymbol = details.tokenSymbol;

    // Validate critical fields - require either website or meaningful description
    if (!fullProjectData.project_name || (!fullProjectData.website && !details.description)) {
      logger.debug(`Filtering out ${project.name}: missing critical fields (name and either website or description)`);
      return null;
    }
    
    // Extract domain if website is available for deduplication
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
  // DAO Maker descriptions can be short on listing pages, so relax this.
  // if (!project.description || project.description.length < 100) {
  //   logger.debug(`Filtering out ${project.project_name}: insufficient description`);
  //   return false;
  // }
  
  // Must have at least website or strong social presence
  if (!project.website && !project.twitter && !project.linkedin) {
    logger.debug(`Filtering out ${project.project_name}: no website or key social links`);
    return false;
  }
  
  // Filter out obvious spam or low-quality projects
  const name = project.project_name.toLowerCase();
  const description = project.description ? project.description.toLowerCase() : '';
  
  // Skip obvious meme or gambling projects
  if (name.includes('meme') || name.includes('casino') || name.includes('bet') ||
      description.includes('meme') || description.includes('gambling')) {
    logger.debug(`Filtering out low-quality project: ${project.project_name}`);
    return false;
  }
  
  // Skip projects with very generic descriptions
  const genericPhrases = ['revolutionary', 'next generation', 'game changing', 'world first'];
  const genericCount = genericPhrases.filter(phrase => description.includes(phrase)).length;
  if (genericCount >= 2 && description.length < 200) {
    logger.debug(`Filtering out ${project.project_name}: too generic description`);
    return false;
  }
  
  return true;
}

module.exports = { scrapeDAOMaker };