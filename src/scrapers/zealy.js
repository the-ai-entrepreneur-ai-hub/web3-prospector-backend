const { PlaywrightHelper } = require('../utils/playwright-helper');
const { extractDomain } = require('../utils/dedup');
const { createLogger } = require('../utils/logger');
const { createProxyRotator } = require('../utils/proxy');

/**
 * Zealy scraper for Web3 communities and campaigns.
 * 
 * Scrapes Zealy's community listings to find active Web3 projects
 * with ongoing campaigns, quests, and community engagement programs.
 */
async function scrapeZealy() {
  const logger = createLogger('Zealy');
  const proxyRotator = createProxyRotator();
  const startTime = Date.now();
  
  logger.info('Starting Zealy scraper for Web3 communities and campaigns');
  
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
    
    // Scrape community sections
    const sections = [
      { name: 'Explore', url: 'https://zealy.io/explore' },
      { name: 'Communities', url: 'https://zealy.io/communities' }
    ];
    
    for (const section of sections) {
      try {
        logger.info(`Scraping ${section.name} section`);
        const sectionResults = await scrapeZealySection(playHelper, section, logger);
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
    
    // Process community details
    logger.info(`Found ${results.length} communities. Getting detailed information...`);
    logger.startProgress('community-processing', Math.min(results.length, 30), 'Processing community details');
    
    const detailedResults = [];
    const maxCommunities = Math.min(results.length, 30); // Limit for production reliability
    
    for (let i = 0; i < maxCommunities; i++) {
      const community = results[i];
      
      try {
        logger.updateProgress('community-processing', i + 1, `${community.name}`);
        
        const detailedData = await scrapeZealyCommunityDetails(playHelper, community, logger);
        if (detailedData) {
          // Apply filtering
          if (shouldIncludeZealyCommunity(detailedData, logger)) {
            detailedResults.push(detailedData);
            stats.processed++;
          } else {
            stats.filtered++;
          }
        }
        
        // Rate limiting between requests
        await playHelper.sleep(1800);
        
      } catch (error) {
        logger.error(`Error processing ${community.name}:`, error);
        stats.errors++;
        continue;
      }
    }
    
    logger.completeProgress('community-processing', `${detailedResults.length} communities processed successfully`);
    
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
    logger.error('Zealy scraper error:', error);
    stats.errors++;
  } finally {
    await playHelper.cleanup();
  }
  
  // Final statistics
  stats.duration = Date.now() - startTime;
  
  logger.info('=== ZEALY SCRAPING STATISTICS ===');
  logger.info(`Communities Found: ${stats.found}`);
  logger.info(`Communities Processed: ${stats.processed}`);
  logger.info(`Communities Filtered: ${stats.filtered}`);
  logger.info(`Errors: ${stats.errors}`);
  logger.info(`Duration: ${(stats.duration / 1000).toFixed(1)}s`);
  logger.info(`Success Rate: ${stats.found > 0 ? ((stats.processed / stats.found) * 100).toFixed(1) : '0.0'}%`);
  
  logger.success(`Zealy scraping completed: ${results.length} communities extracted`);
  
  return results;
}

/**
 * Scrape a specific section from Zealy
 */
async function scrapeZealySection(playHelper, section, logger) {
  logger.info(`Loading ${section.name} section`);
  
  await playHelper.navigateTo(section.url);
  
  // Wait for community list to load
  const selectors = playHelper.getSelectors('zealy');
  const { communityCards, communityName, description, socialLinks, website, members } = selectors.selectors;
  
  await playHelper.waitForElement(communityCards, { timeout: 30000 });
  
  // Handle potential infinite scroll
  await playHelper.scrollDownUntilNoNewContent(communityCards[0], 500, 5);
  
  // Extract community URLs
  const communityUrls = await playHelper.page.evaluate((cardSelectors, nameSelectors, memberSelectors) => {
    const communities = [];
    const containers = document.querySelectorAll(cardSelectors.join(', '));
    
    containers.forEach((container) => {
      const linkElement = container.querySelector('a[href*="/c/"], a[href*="/community/"]');
      if (linkElement && linkElement.href) {
        const nameElement = container.querySelector(nameSelectors.join(', '));
        const name = nameElement ? nameElement.textContent.trim() : 'Unknown Community';
        
        // Get member count if available
        const memberElement = container.querySelector(memberSelectors.join(', '));
        const memberCount = memberElement ? memberElement.textContent.trim() : null;
        
        communities.push({
          name,
          url: linkElement.href,
          memberCount,
          source: 'Zealy'
        });
      }
    });
    
    return communities;
  }, communityCards, communityName, members);
  
  logger.success(`Extracted ${communityUrls.length} communities from ${section.name}`);
  return communityUrls;
}

/**
 * Scrape detailed information for a specific community
 */
async function scrapeZealyCommunityDetails(playHelper, community, logger) {
  try {
    logger.debug(`Getting details for ${community.name}`);
    
    await playHelper.navigateTo(community.url);
    
    const selectors = playHelper.getSelectors('zealy');
    const { description: descSelectors, website: websiteSelectors, socialLinks: socialLinkSelectors, members: membersSelectors } = selectors.selectors;

    // Extract comprehensive community data
    const communityData = await playHelper.page.evaluate((descSelectors, websiteSelectors, socialLinkSelectors, membersSelectors) => {
      const data = {
        description: null,
        category: null,
        website: null,
        questCount: null,
        socialLinks: {}
      };
      
      // Extract description
      for (const selector of descSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent.trim().length > 30) {
          data.description = element.textContent.trim();
          break;
        }
      }
      
      // Extract quest count (Zealy doesn't have a direct quest count selector in selectors.json, so use a generic one)
      const questElement = document.querySelector('.quest-count, .quests, .tasks-count');
      if (questElement) {
        const questText = questElement.textContent.trim();
        const questMatch = questText.match(/(\d+)/);
        if (questMatch) {
          data.questCount = parseInt(questMatch[1]);
        }
      }
      
      // Extract website
      for (const selector of websiteSelectors) {
        const element = document.querySelector(selector);
        if (element && element.href && !element.href.includes('zealy.io')) {
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
      
      return data;
    }, descSelectors, websiteSelectors, socialLinkSelectors, membersSelectors);
    
    // Build complete community data in the required format
    const fullCommunityData = {
      project_name: community.name,
      website: communityData.website || null,
      sale_type: 'Community/Quest', // Zealy lists communities and quests
      launchpad: 'Zealy',
      category: communityData.category || 'Web3 Community', // Default category if not found
      launch_date: null, // Zealy doesn't provide a specific launch date
      funding_raised: 'N/A', // Not applicable for Zealy
      details_url: community.url,
      source: 'Zealy'
    };

    // Validate critical fields
    if (!fullCommunityData.project_name || !fullCommunityData.website || !fullCommunityData.details_url) {
      logger.debug(`Filtering out ${community.name}: missing critical fields (name, website, or details URL)`);
      return null;
    }
    
    // Extract domain if website available for deduplication
    if (fullCommunityData.website) {
      fullCommunityData.domain = extractDomain(fullCommunityData.website);
    }
    
    return fullCommunityData;
    
  } catch (error) {
    logger.debug(`Failed to get details for ${community.name}: ${error.message}`);
    return null;
  }
}

/**
 * Filter function to determine if a community should be included
 */
function shouldIncludeZealyCommunity(community, logger) {
  // Must have website or strong social presence
  if (!community.website && !community.twitter && !community.discord) {
    logger.debug(`Filtering out ${community.project_name}: no website or key social links`);
    return false;
  }
  
  // Filter out very small communities (less than 50 members if count available)
  if (community.memberCount) {
    const memberMatch = String(community.memberCount).match(/(\d+)/); // Ensure memberCount is a string for regex
    if (memberMatch && parseInt(memberMatch[1]) < 50) {
      logger.debug(`Filtering out ${community.project_name}: too few members (${community.memberCount})`);
      return false;
    }
  }
  
  // Filter out obvious spam or low-quality communities
  const name = community.project_name.toLowerCase();
  const description = (community.description || '').toLowerCase();
  
  if (name.includes('test') || name.includes('fake') || name.includes('spam') ||
      description.includes('test community') || description.length < 20) {
    logger.debug(`Filtering out low-quality community: ${community.project_name}`);
    return false;
  }
  
  return true;
}

module.exports = { scrapeZealy };