const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { createLogger } = require('./logger');
const { createProxyRotator } = require('./proxy');

/**
 * Social Media Fallback System
 * 
 * When Snovio enrichment fails, this system:
 * 1. Scrapes the project website for social media handles
 * 2. Extracts LinkedIn profiles of team members
 * 3. Uses LinkedIn profiles to retry Snovio enrichment
 * 4. Provides comprehensive social media contact information
 */

class SocialFallbackEnrichment {
  constructor() {
    this.logger = createLogger('SocialFallback');
    this.proxyRotator = createProxyRotator();
  }

  /**
   * Main enrichment function that attempts multiple fallback strategies
   */
  async enrichProject(project) {
    const logger = this.logger;
    const startTime = Date.now();
    
    logger.info(`Starting enhanced social fallback enrichment for ${project.name}`);
    
    let enrichedData = {
      ...project,
      socialHandles: {},
      teamLinkedInProfiles: [],
      contacts: [],
      enrichmentSources: [],
      fallbackAttempts: 0
    };

    try {
      // Strategy 1: Website scraping for social handles and team info
      if (project.website) {
        logger.info(`Attempting website social scraping for ${project.name}`);
        const websiteData = await this.scrapeWebsiteSocials(project.website);
        
        if (websiteData) {
          enrichedData.socialHandles = { ...enrichedData.socialHandles, ...websiteData.socials };
          enrichedData.teamLinkedInProfiles = websiteData.linkedinProfiles || [];
          enrichedData.enrichmentSources.push('website-scraping');
          enrichedData.fallbackAttempts++;
          
          logger.success(`Found ${Object.keys(websiteData.socials).length} social handles and ${websiteData.linkedinProfiles.length} LinkedIn profiles`);
        }
      }

      // Strategy 2: LinkedIn company search and discovery
      const domain = this.extractDomainFromUrl(project.website || '');
      if (domain && !enrichedData.teamLinkedInProfiles.length) {
        logger.info(`Attempting LinkedIn company discovery for ${project.name}`);
        const linkedinCompanyData = await this.discoverLinkedInCompany(project.name, domain);
        
        if (linkedinCompanyData && linkedinCompanyData.profiles.length > 0) {
          enrichedData.teamLinkedInProfiles.push(...linkedinCompanyData.profiles);
          enrichedData.enrichmentSources.push('linkedin-search');
          enrichedData.fallbackAttempts++;
          
          logger.success(`Found ${linkedinCompanyData.profiles.length} LinkedIn profiles via company search`);
        }
      }

      // Strategy 3: GitHub organization enrichment
      if (project.github || enrichedData.socialHandles.github) {
        logger.info(`Attempting GitHub organization enrichment for ${project.name}`);
        const githubData = await this.enrichFromGitHub(project.github || enrichedData.socialHandles.github?.url);
        
        if (githubData && githubData.contacts.length > 0) {
          enrichedData.contacts.push(...githubData.contacts);
          enrichedData.enrichmentSources.push('github-org');
          enrichedData.fallbackAttempts++;
          
          logger.success(`Found ${githubData.contacts.length} contacts via GitHub enrichment`);
        }
      }

      // Strategy 4: Enhanced email pattern generation from team data
      if (enrichedData.teamLinkedInProfiles.length > 0 && domain) {
        logger.info(`Generating email patterns from team data for ${project.name}`);
        const emailPatterns = await this.generateEmailPatternsFromTeam(enrichedData.teamLinkedInProfiles, domain);
        
        if (emailPatterns.length > 0) {
          enrichedData.contacts.push(...emailPatterns);
          enrichedData.enrichmentSources.push('email-patterns');
          enrichedData.fallbackAttempts++;
          
          logger.success(`Generated ${emailPatterns.length} email patterns from team data`);
        }
      }

      // Strategy 5: Twitter/X profile enrichment
      if (project.twitter || enrichedData.socialHandles.twitter) {
        logger.info(`Attempting Twitter profile enrichment for ${project.name}`);
        const twitterData = await this.enrichFromTwitter(project.twitter || enrichedData.socialHandles.twitter?.url);
        
        if (twitterData && twitterData.contacts.length > 0) {
          enrichedData.contacts.push(...twitterData.contacts);
          enrichedData.enrichmentSources.push('twitter-profile');
          enrichedData.fallbackAttempts++;
          
          logger.success(`Found ${twitterData.contacts.length} contacts via Twitter enrichment`);
        }
      }

      // Strategy 6: Telegram channel enrichment
      if (project.telegram || enrichedData.socialHandles.telegram) {
        logger.info(`Attempting Telegram channel enrichment for ${project.name}`);
        const telegramData = await this.enrichFromTelegram(project.telegram || enrichedData.socialHandles.telegram?.url);
        
        if (telegramData && telegramData.contacts.length > 0) {
          enrichedData.contacts.push(...telegramData.contacts);
          enrichedData.enrichmentSources.push('telegram-channel');
          enrichedData.fallbackAttempts++;
          
          logger.success(`Found ${telegramData.contacts.length} contacts via Telegram enrichment`);
        }
      }

      // Strategy 7: Enhance existing social media links
      if (project.twitter || project.linkedin || project.telegram) {
        logger.info(`Enhancing existing social media data for ${project.name}`);
        const enhancedSocials = await this.enhanceExistingSocials({
          twitter: project.twitter,
          linkedin: project.linkedin,
          telegram: project.telegram,
          discord: project.discord,
          github: project.github
        });
        
        if (enhancedSocials) {
          enrichedData.socialHandles = { ...enrichedData.socialHandles, ...enhancedSocials };
          enrichedData.enrichmentSources.push('social-enhancement');
          enrichedData.fallbackAttempts++;
        }
      }

      // Deduplicate and rank contacts by decision-maker potential
      enrichedData.contacts = this.deduplicateAndRankContacts(enrichedData.contacts);

      const duration = Date.now() - startTime;
      enrichedData.enrichmentDuration = duration;
      
      logger.info(`Enhanced social fallback enrichment completed for ${project.name} in ${duration}ms with ${enrichedData.fallbackAttempts} strategies, found ${enrichedData.contacts.length} contacts`);
      
      return enrichedData;

    } catch (error) {
      logger.error(`Social fallback enrichment failed for ${project.name}:`, error);
      return enrichedData;
    }
  }

  /**
   * Scrape social media handles from project website
   */
  async scrapeWebsiteSocials(websiteUrl) {
    const logger = this.logger;
    let browser;

    try {
      logger.debug(`Scraping social handles from: ${websiteUrl}`);
      
      // Create browser with proxy
      const { browser: proxyBrowser, page, proxyData } = await this.proxyRotator.createBrowserWithProxy(puppeteer, [
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]);
      
      browser = proxyBrowser;
      await page.setViewport({ width: 1920, height: 1080 });
      
      // Navigate to website
      await page.goto(websiteUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      // Extract social media links and team information
      const socialData = await page.evaluate(() => {
        const data = {
          socials: {},
          linkedinProfiles: [],
          teamMembers: []
        };

        // Find all links on the page
        const allLinks = document.querySelectorAll('a[href]');
        
        allLinks.forEach(link => {
          const href = link.href.toLowerCase();
          const text = (link.textContent || '').trim();
          
          // Extract social media handles
          if (href.includes('twitter.com') || href.includes('x.com')) {
            const match = href.match(/(?:twitter\.com|x\.com)\/([^\/\?]+)/);
            if (match && match[1] && !match[1].includes('intent')) {
              data.socials.twitter = {
                url: link.href,
                handle: '@' + match[1],
                platform: 'Twitter'
              };
            }
          } else if (href.includes('linkedin.com')) {
            const match = href.match(/linkedin\.com\/(?:in|company)\/([^\/\?]+)/);
            if (match && match[1]) {
              if (href.includes('/company/')) {
                data.socials.linkedin = {
                  url: link.href,
                  handle: match[1],
                  platform: 'LinkedIn Company'
                };
              } else if (href.includes('/in/')) {
                // Individual LinkedIn profile - potential team member
                data.linkedinProfiles.push({
                  url: link.href,
                  handle: match[1],
                  name: text || match[1],
                  context: this.getElementContext(link)
                });
              }
            }
          } else if (href.includes('t.me') || href.includes('telegram')) {
            const match = href.match(/t\.me\/([^\/\?]+)/);
            if (match && match[1]) {
              data.socials.telegram = {
                url: link.href,
                handle: '@' + match[1],
                platform: 'Telegram'
              };
            }
          } else if (href.includes('discord')) {
            data.socials.discord = {
              url: link.href,
              platform: 'Discord'
            };
          } else if (href.includes('github.com')) {
            const match = href.match(/github\.com\/([^\/\?]+)/);
            if (match && match[1]) {
              data.socials.github = {
                url: link.href,
                handle: match[1],
                platform: 'GitHub'
              };
            }
          } else if (href.includes('medium.com')) {
            const match = href.match(/medium\.com\/(@[^\/\?]+)/);
            if (match && match[1]) {
              data.socials.medium = {
                url: link.href,
                handle: match[1],
                platform: 'Medium'
              };
            }
          }
        });

        // Look for team sections to find more LinkedIn profiles
        const teamSections = document.querySelectorAll([
          '.team', '.about-team', '.our-team', '.founders',
          '.leadership', '.advisors', '[id*="team"]', '[class*="team"]',
          '.bio', '.profile', '.member'
        ].join(', '));

        teamSections.forEach(section => {
          const linkedinLinks = section.querySelectorAll('a[href*="linkedin.com/in/"]');
          linkedinLinks.forEach(link => {
            const match = link.href.match(/linkedin\.com\/in\/([^\/\?]+)/);
            if (match && match[1]) {
              // Get name from nearby text
              const name = this.extractNameFromContext(link) || match[1];
              
              data.linkedinProfiles.push({
                url: link.href,
                handle: match[1],
                name: name,
                context: 'team-section',
                role: this.extractRoleFromContext(link)
              });
            }
          });
        });

        return data;
      });

      // Remove duplicates from LinkedIn profiles
      const uniqueLinkedInProfiles = socialData.linkedinProfiles.filter((profile, index, arr) => 
        arr.findIndex(p => p.url === profile.url) === index
      );

      logger.debug(`Found ${Object.keys(socialData.socials).length} social handles and ${uniqueLinkedInProfiles.length} LinkedIn profiles`);

      return {
        socials: socialData.socials,
        linkedinProfiles: uniqueLinkedInProfiles
      };

    } catch (error) {
      logger.debug(`Failed to scrape social handles from ${websiteUrl}: ${error.message}`);
      return null;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Extract emails directly from website
   */
  async scrapeWebsiteEmails(websiteUrl) {
    const logger = this.logger;
    let browser;

    try {
      logger.debug(`Scraping emails from: ${websiteUrl}`);
      
      // Create browser with proxy
      const { browser: proxyBrowser, page, proxyData } = await this.proxyRotator.createBrowserWithProxy(puppeteer, [
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]);
      
      browser = proxyBrowser;
      await page.setViewport({ width: 1920, height: 1080 });
      
      // Navigate to website
      await page.goto(websiteUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      // Also try contact page if it exists
      const contactPages = [
        '/contact', '/contact-us', '/about', '/team', '/support'
      ];

      const emails = new Set();
      
      // Extract emails from main page
      const mainPageEmails = await page.evaluate(() => {
        const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
        const pageText = document.body.textContent;
        return pageText.match(emailRegex) || [];
      });

      mainPageEmails.forEach(email => emails.add(email.toLowerCase()));

      // Try to visit contact pages
      for (const contactPath of contactPages) {
        try {
          const contactUrl = new URL(contactPath, websiteUrl).href;
          await page.goto(contactUrl, {
            waitUntil: 'networkidle2',
            timeout: 15000
          });

          const contactEmails = await page.evaluate(() => {
            const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
            const pageText = document.body.textContent;
            return pageText.match(emailRegex) || [];
          });

          contactEmails.forEach(email => emails.add(email.toLowerCase()));
          
        } catch (e) {
          // Contact page doesn't exist or failed to load
          continue;
        }
      }

      const emailList = Array.from(emails).filter(email => 
        !email.includes('example.com') && 
        !email.includes('domain.com') &&
        !email.includes('placeholder')
      );

      logger.debug(`Found ${emailList.length} emails on ${websiteUrl}`);

      return emailList.length > 0 ? { emails: emailList.map(email => ({ email })) } : null;

    } catch (error) {
      logger.debug(`Failed to scrape emails from ${websiteUrl}: ${error.message}`);
      return null;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Use LinkedIn profiles to find emails via Snovio
   */
  async enrichFromLinkedInProfiles(linkedinProfiles, snovioService) {
    const logger = this.logger;
    
    try {
      logger.debug(`Attempting Snovio enrichment for ${linkedinProfiles.length} LinkedIn profiles`);
      
      const allEmails = [];
      
      for (const profile of linkedinProfiles.slice(0, 5)) { // Limit to first 5 profiles
        try {
          // Extract domain from LinkedIn profile to use with Snovio
          const firstName = profile.name.split(' ')[0];
          const lastName = profile.name.split(' ').slice(1).join(' ');
          
          if (firstName && lastName) {
            logger.debug(`Searching for ${firstName} ${lastName} via Snovio`);
            
            // Try to find email using LinkedIn profile information
            const searchResult = await snovioService.findPersonByName(firstName, lastName);
            
            if (searchResult && searchResult.emails && searchResult.emails.length > 0) {
              allEmails.push(...searchResult.emails.map(email => ({
                ...email,
                source: 'linkedin-snovio',
                linkedinProfile: profile.url,
                name: profile.name
              })));
            }
          }
          
          // Add delay between requests
          await new Promise(resolve => setTimeout(resolve, 2000));
          
        } catch (error) {
          logger.debug(`Failed to enrich LinkedIn profile ${profile.url}: ${error.message}`);
          continue;
        }
      }
      
      logger.debug(`LinkedIn enrichment found ${allEmails.length} email addresses`);
      
      return allEmails.length > 0 ? { emails: allEmails } : null;
      
    } catch (error) {
      logger.debug(`LinkedIn enrichment failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Discover LinkedIn company and employees via search
   */
  async discoverLinkedInCompany(companyName, domain) {
    const logger = this.logger;
    
    try {
      // Search Google for LinkedIn company page
      const searchQuery = `site:linkedin.com/company "${companyName}" OR "${domain}"`;
      const searchResults = await this.searchGoogle(searchQuery);
      
      const profiles = [];
      
      // Look for company page in search results
      for (const result of searchResults.slice(0, 5)) {
        if (result.url.includes('linkedin.com/company/')) {
          logger.debug(`Found LinkedIn company page: ${result.url}`);
          
          // Search for employees of this company
          const employeeQuery = `site:linkedin.com/in "${companyName}" OR "${domain}" (CEO OR CTO OR founder OR "head of" OR director)`;
          const employeeResults = await this.searchGoogle(employeeQuery);
          
          for (const employee of employeeResults.slice(0, 10)) {
            if (employee.url.includes('linkedin.com/in/')) {
              profiles.push({
                url: employee.url,
                handle: this.extractLinkedInHandle(employee.url),
                name: this.extractNameFromSearchResult(employee.title),
                role: this.extractRoleFromSearchResult(employee.title),
                context: 'linkedin-search',
                decisionMakerScore: this.calculateDecisionMakerScore(employee.title)
              });
            }
          }
          break;
        }
      }
      
      // Sort by decision maker score
      profiles.sort((a, b) => b.decisionMakerScore - a.decisionMakerScore);
      
      return profiles.length > 0 ? { profiles } : null;
      
    } catch (error) {
      logger.debug(`LinkedIn company discovery failed: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Enrich from GitHub organization
   */
  async enrichFromGitHub(githubUrl) {
    const logger = this.logger;
    
    try {
      if (!githubUrl) return null;
      
      const orgMatch = githubUrl.match(/github\.com\/([^\/\?]+)/);
      if (!orgMatch) return null;
      
      const orgName = orgMatch[1];
      logger.debug(`Enriching GitHub org: ${orgName}`);
      
      // Try to get org info via GitHub API (public data only)
      const orgResponse = await axios.get(`https://api.github.com/orgs/${orgName}`, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Web3Prospector/1.0)'
        }
      });
      
      const contacts = [];
      
      // Check if org has public email
      if (orgResponse.data.email) {
        contacts.push({
          email: orgResponse.data.email,
          name: orgResponse.data.name || orgName,
          position: 'Organization Contact',
          source: 'github-org',
          confidence: 0.8,
          decisionMakerScore: 5
        });
      }
      
      // Try to get organization members (public data only)
      try {
        const membersResponse = await axios.get(`https://api.github.com/orgs/${orgName}/members`, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Web3Prospector/1.0)'
          }
        });
        
        // For each member, try to get their profile for email
        for (const member of membersResponse.data.slice(0, 5)) {
          try {
            const userResponse = await axios.get(`https://api.github.com/users/${member.login}`, {
              timeout: 5000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Web3Prospector/1.0)'
              }
            });
            
            if (userResponse.data.email && userResponse.data.name) {
              contacts.push({
                email: userResponse.data.email,
                name: userResponse.data.name,
                position: 'Developer',
                source: 'github-member',
                confidence: 0.7,
                decisionMakerScore: 2,
                githubProfile: userResponse.data.html_url
              });
            }
          } catch (memberError) {
            // Member profile not accessible or no email
            continue;
          }
        }
      } catch (membersError) {
        logger.debug(`Could not fetch GitHub org members: ${membersError.message}`);
      }
      
      return contacts.length > 0 ? { contacts } : null;
      
    } catch (error) {
      logger.debug(`GitHub enrichment failed: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Generate email patterns from team LinkedIn profiles
   */
  async generateEmailPatternsFromTeam(linkedinProfiles, domain) {
    const contacts = [];
    
    // Sort profiles by decision maker score
    const sortedProfiles = linkedinProfiles.sort((a, b) => (b.decisionMakerScore || 0) - (a.decisionMakerScore || 0));
    
    for (const profile of sortedProfiles.slice(0, 10)) {
      if (!profile.name || profile.name === 'Unknown') continue;
      
      const emailPatterns = this.generateEmailPatterns(profile.name, domain);
      
      for (const email of emailPatterns) {
        contacts.push({
          email,
          name: profile.name,
          position: profile.role || '',
          source: 'email-pattern',
          confidence: 0.4, // Lower confidence for generated patterns
          decisionMakerScore: profile.decisionMakerScore || 0,
          linkedinProfile: profile.url
        });
      }
    }
    
    return contacts;
  }
  
  /**
   * Enrich from Twitter profile
   */
  async enrichFromTwitter(twitterUrl) {
    const logger = this.logger;
    
    try {
      if (!twitterUrl) return null;
      
      logger.debug(`Enriching Twitter profile: ${twitterUrl}`);
      
      // Use web scraping to get profile info (no API key needed)
      const response = await axios.get(twitterUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      const $ = cheerio.load(response.data);
      const contacts = [];
      
      // Look for email in bio or pinned tweets
      const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
      const pageText = $.text();
      const emails = pageText.match(emailRegex) || [];
      
      emails.forEach(email => {
        if (this.isValidEmail(email)) {
          contacts.push({
            email: email.toLowerCase(),
            name: '',
            position: '',
            source: 'twitter-profile',
            confidence: 0.6,
            decisionMakerScore: 0
          });
        }
      });
      
      // Look for website links that might lead to contact pages
      $('a[href]').each((_, element) => {
        const href = $(element).attr('href');
        if (href && (href.includes('http') && !href.includes('twitter.com') && !href.includes('x.com'))) {
          // This could be their website - we could recursively check it
          // For now, just note it
        }
      });
      
      return contacts.length > 0 ? { contacts } : null;
      
    } catch (error) {
      logger.debug(`Twitter enrichment failed: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Enrich from Telegram channel
   */
  async enrichFromTelegram(telegramUrl) {
    const logger = this.logger;
    
    try {
      if (!telegramUrl) return null;
      
      logger.debug(`Enriching Telegram channel: ${telegramUrl}`);
      
      // Try to access the public Telegram channel page
      const response = await axios.get(telegramUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      const $ = cheerio.load(response.data);
      const contacts = [];
      
      // Look for email in channel description
      const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
      const pageText = $('.tgme_channel_info_description').text() || $.text();
      const emails = pageText.match(emailRegex) || [];
      
      emails.forEach(email => {
        if (this.isValidEmail(email)) {
          contacts.push({
            email: email.toLowerCase(),
            name: '',
            position: '',
            source: 'telegram-channel',
            confidence: 0.5,
            decisionMakerScore: 0
          });
        }
      });
      
      return contacts.length > 0 ? { contacts } : null;
      
    } catch (error) {
      logger.debug(`Telegram enrichment failed: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Search Google for specific queries
   */
  async searchGoogle(query) {
    try {
      // Use a simple HTTP request to search (this is a basic implementation)
      // In production, you might want to use a proper search API
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10`;
      
      const response = await axios.get(searchUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      const $ = cheerio.load(response.data);
      const results = [];
      
      // Parse search results
      $('.g').each((_, element) => {
        const titleElement = $(element).find('h3').first();
        const linkElement = $(element).find('a[href^="http"]').first();
        
        const title = titleElement.text().trim();
        const url = linkElement.attr('href');
        
        if (title && url) {
          results.push({ title, url });
        }
      });
      
      return results;
      
    } catch (error) {
      this.logger.debug(`Google search failed: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Extract domain from URL
   */
  extractDomainFromUrl(url) {
    try {
      if (!url) return '';
      const domain = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
      return domain.replace('www.', '');
    } catch (error) {
      return '';
    }
  }
  
  /**
   * Generate email patterns from name and domain
   */
  generateEmailPatterns(name, domain) {
    if (!name || !domain) return [];
    
    const nameParts = name.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
    if (nameParts.length < 1) return [];
    
    const firstName = nameParts[0];
    const lastName = nameParts[nameParts.length - 1];
    
    const patterns = [];
    
    if (firstName && lastName && firstName !== lastName) {
      patterns.push(`${firstName}.${lastName}@${domain}`);
      patterns.push(`${firstName}@${domain}`);
      patterns.push(`${firstName[0]}.${lastName}@${domain}`);
      patterns.push(`${firstName}${lastName}@${domain}`);
      patterns.push(`${firstName[0]}${lastName}@${domain}`);
    } else if (firstName) {
      patterns.push(`${firstName}@${domain}`);
    }
    
    return patterns;
  }
  
  /**
   * Calculate decision maker score based on title/role
   */
  calculateDecisionMakerScore(title) {
    if (!title) return 0;
    
    const titleLower = title.toLowerCase();
    
    // C-level executives
    if (titleLower.includes('ceo') || titleLower.includes('chief executive')) return 10;
    if (titleLower.includes('cto') || titleLower.includes('chief technology')) return 9;
    if (titleLower.includes('cfo') || titleLower.includes('chief financial')) return 9;
    if (titleLower.includes('cmo') || titleLower.includes('chief marketing')) return 8;
    if (titleLower.includes('chief')) return 7;
    
    // Founders
    if (titleLower.includes('founder') || titleLower.includes('co-founder')) return 10;
    
    // VPs and Directors
    if (titleLower.includes('vp ') || titleLower.includes('vice president')) return 6;
    if (titleLower.includes('director')) return 5;
    
    // Department heads
    if (titleLower.includes('head of') || titleLower.includes('lead ')) return 4;
    if (titleLower.includes('manager')) return 3;
    
    // Business development
    if (titleLower.includes('business development') || titleLower.includes('partnerships')) return 6;
    if (titleLower.includes('growth')) return 5;
    
    return 1;
  }
  
  /**
   * Extract LinkedIn handle from URL
   */
  extractLinkedInHandle(url) {
    const match = url.match(/linkedin\.com\/in\/([^\/\?]+)/);
    return match ? match[1] : '';
  }
  
  /**
   * Extract name from search result title
   */
  extractNameFromSearchResult(title) {
    // LinkedIn titles usually have format "Name - Title at Company | LinkedIn"
    const match = title.match(/^([^-|]+)/);
    return match ? match[1].trim() : '';
  }
  
  /**
   * Extract role from search result title
   */
  extractRoleFromSearchResult(title) {
    // Extract role between - and | or at
    const match = title.match(/-\s*([^|]+?)\s*(?:at\s+[^|]+)?\s*\|/);
    if (match) return match[1].trim();
    
    const atMatch = title.match(/at\s+([^|]+)/);
    return atMatch ? atMatch[1].trim() : '';
  }
  
  /**
   * Validate email format
   */
  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidDomains = ['example.com', 'test.com', 'domain.com'];
    
    if (!emailRegex.test(email)) return false;
    
    const domain = email.split('@')[1];
    return !invalidDomains.includes(domain);
  }
  
  /**
   * Deduplicate and rank contacts by decision maker score
   */
  deduplicateAndRankContacts(contacts) {
    // Remove duplicates by email
    const uniqueContacts = contacts.filter((contact, index, arr) => 
      arr.findIndex(c => c.email === contact.email) === index
    );
    
    // Sort by decision maker score (highest first), then by confidence
    return uniqueContacts.sort((a, b) => {
      const scoreA = (a.decisionMakerScore || 0) * 10 + (a.confidence || 0);
      const scoreB = (b.decisionMakerScore || 0) * 10 + (b.confidence || 0);
      return scoreB - scoreA;
    });
  }
  
  /**
   * Enhance existing social media links with additional data
   */
  async enhanceExistingSocials(existingSocials) {
    const enhanced = {};
    
    Object.entries(existingSocials).forEach(([platform, url]) => {
      if (!url) return;
      
      let handle = null;
      
      switch (platform) {
        case 'twitter':
          const twitterMatch = url.match(/(?:twitter\.com|x\.com)\/([^\/\?]+)/);
          if (twitterMatch && twitterMatch[1]) {
            handle = '@' + twitterMatch[1];
          }
          break;
          
        case 'telegram':
          const telegramMatch = url.match(/t\.me\/([^\/\?]+)/);
          if (telegramMatch && telegramMatch[1]) {
            handle = '@' + telegramMatch[1];
          }
          break;
          
        case 'github':
          const githubMatch = url.match(/github\.com\/([^\/\?]+)/);
          if (githubMatch && githubMatch[1]) {
            handle = githubMatch[1];
          }
          break;
          
        case 'linkedin':
          const linkedinMatch = url.match(/linkedin\.com\/(?:in|company)\/([^\/\?]+)/);
          if (linkedinMatch && linkedinMatch[1]) {
            handle = linkedinMatch[1];
          }
          break;
      }
      
      if (handle) {
        enhanced[platform] = {
          url: url,
          handle: handle,
          platform: platform.charAt(0).toUpperCase() + platform.slice(1)
        };
      }
    });
    
    return enhanced;
  }
}

/**
 * Create a social fallback enrichment instance
 */
function createSocialFallback() {
  return new SocialFallbackEnrichment();
}

module.exports = {
  SocialFallbackEnrichment,
  createSocialFallback
};