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

  // Save results to file
  const outputDir = path.join(__dirname, '..', '..', 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const outputFile = path.join(outputDir, 'DAOMaker.json');
  console.log("DAO Maker scraper execution finished."); // Added for debugging
  return results;
}

/**
 * Scrape a specific section from DAO Maker
 */
async function scrapeDAOMakerSection(playHelper, section, logger) {
  logger.info(`Loading ${section.name} section`);
  
  await playHelper.navigateTo(section.url);
  
  const selectors = playHelper.getSelectors('daomaker');
  const { projectCards, projectName, projectStatus, description } = selectors.selectors;

  // Wait for projects to load - try multiple selectors
  try {
    await playHelper.waitForElement(projectCards, { timeout: 30000 });
  } catch (e) {
    // Try alternative loading approach
    await playHelper.sleep(5000);
    await playHelper.navigateTo(section.url); // Reload page
    await playHelper.waitForElement(projectCards, { timeout: 30000 });
  }
  
  // Scroll down to load more projects if available
  await playHelper.scrollDownUntilNoNewContent(projectCards[0], 500, 5); // Scroll 5 times, 500ms delay

  // Extract project information from the section
  const projects = await playHelper.page.evaluate((sectionName, cardSelectors, nameSelectors, statusSelectors, descSelectors) => {
    const projectElements = document.querySelectorAll(cardSelectors.join(', '));
    
    const projects = [];
    
    projectElements.forEach((element) => {
      let link = element;
      if (element.tagName !== 'A') {
        link = element.querySelector('a');
      }
      
      if (!link || !link.href || !link.href.includes('/projects/')) return;
      
      // Extract project name
      const nameElement = element.querySelector(nameSelectors.join(', '));
      const name = nameElement ? nameElement.textContent.trim() : 
                   link.href.split('/projects/')[1]?.split('?')[0]?.replace(/-/g, ' ') || 'Unknown Project';
      
      // Extract project status/stage
      const statusElement = element.querySelector(statusSelectors.join(', '));
      const status = statusElement ? statusElement.textContent.trim() : sectionName;
      
      // Extract description if available
      const descElement = element.querySelector(descSelectors.join(', '));
      const description = descElement ? descElement.textContent.trim() : null;
      
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
    });
    
    return projects;
  }, section.name, projectCards, projectName, projectStatus, description);
  
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
    
    const selectors = playHelper.getSelectors('daomaker');
    const { description: descSelectors, socialLinks: socialLinkSelectors, website: websiteSelectors, projectInfo: metaSelectors } = selectors.selectors;

    // Extract detailed information
    const details = await playHelper.page.evaluate((descSelectors, socialLinkSelectors, websiteSelectors, metaSelectors) => {
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
      
      // Extract enhanced description
      for (const selector of descSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent.trim().length > 50) {
          data.description = element.textContent.trim();
          break;
        }
      }
      
      // Extract all social links and website
      const allLinks = document.querySelectorAll(socialLinkSelectors.join(', '));
      
      allLinks.forEach(link => {
        if (!link.href) return;
        
        const url = link.href.toLowerCase();
        const text = (link.textContent || link.title || '').toLowerCase();
        const linkText = `${url} ${text}`;
        
        // Categorize links by domain and content
        if (url.includes('twitter.com') || url.includes('x.com')) {
          data.twitter = link.href;
        } else if (url.includes('discord')) {
          data.discord = link.href;
        } else if (url.includes('t.me') || url.includes('telegram')) {
          data.telegram = link.href;
        } else if (url.includes('github')) {
          data.github = link.href;
        } else if (url.includes('linkedin')) {
          data.linkedin = link.href;
        } else if (url.includes('medium.com')) {
          data.medium = link.href;
        } else if (linkText.includes('whitepaper') || linkText.includes('white paper')) {
          data.whitepaper = link.href;
        } else if (linkText.includes('website') || linkText.includes('visit') || 
                  (text.includes('website') && !url.includes('daomaker.com'))) {
          data.website = link.href;
        } else if (!data.website && url.startsWith('http') && 
                   !url.includes('daomaker.com') && !url.includes('twitter.com') && 
                   !url.includes('discord') && !url.includes('telegram') && 
                   !url.includes('github') && !url.includes('linkedin') && 
                   !url.includes('medium.com')) {
          // Potential website link
          data.website = link.href;
        }
      });
      
      // Extract website specifically using provided selectors if not found yet
      if (!data.website) {
        for (const selector of websiteSelectors) {
          const element = document.querySelector(selector);
          if (element && element.href && !element.href.includes('daomaker.com')) {
            data.website = element.href;
            break;
          }
        }
      }

      // Extract project metadata
      metaSelectors.forEach(selector => {
        const container = document.querySelector(selector);
        if (!container) return;
        
        const items = container.querySelectorAll('.info-item, .detail-item, .stat-item, dt, dd');
        
        items.forEach((item, index) => {
          const text = item.textContent.trim().toLowerCase();
          const nextItem = items[index + 1];
          const value = nextItem ? nextItem.textContent.trim() : '';
          
          if (text.includes('category') || text.includes('sector')) {
            data.category = value || item.textContent.trim();
          } else if (text.includes('symbol') || text.includes('token')) {
            data.tokenSymbol = value || item.textContent.trim();
          } else if (text.includes('raise') || text.includes('target')) {
            data.totalRaise = value || item.textContent.trim();
          } else if (text.includes('blockchain') || text.includes('network')) {
            data.blockchain = value || item.textContent.trim();
          }
        });
      });
      
      return data;
    }, descSelectors, socialLinkSelectors, websiteSelectors, metaSelectors);
    
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

    // Validate critical fields
    if (!fullProjectData.project_name || !fullProjectData.website) { // Launch date might be N/A
      logger.debug(`Filtering out ${project.name}: missing critical fields (name or website)`);
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