const puppeteer = require('puppeteer');
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
  async enrichProject(project, snovioService) {
    const logger = this.logger;
    const startTime = Date.now();
    
    logger.info(`Starting social fallback enrichment for ${project.name}`);
    
    let enrichedData = {
      ...project,
      socialHandles: {},
      teamLinkedInProfiles: [],
      enrichmentSources: [],
      fallbackAttempts: 0
    };

    try {
      // Strategy 1: Try initial website scraping for social handles
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

      // Strategy 2: If we found LinkedIn profiles, try Snovio enrichment on them
      if (enrichedData.teamLinkedInProfiles.length > 0 && snovioService) {
        logger.info(`Attempting LinkedIn-based Snovio enrichment for ${project.name}`);
        const linkedinEnrichment = await this.enrichFromLinkedInProfiles(
          enrichedData.teamLinkedInProfiles, 
          snovioService
        );
        
        if (linkedinEnrichment && linkedinEnrichment.emails.length > 0) {
          enrichedData.contacts = linkedinEnrichment.emails;
          enrichedData.enrichmentSources.push('linkedin-snovio');
          enrichedData.fallbackAttempts++;
          
          logger.success(`Found ${linkedinEnrichment.emails.length} contacts via LinkedIn enrichment`);
        }
      }

      // Strategy 3: Try direct email extraction from website
      if (!enrichedData.contacts || enrichedData.contacts.length === 0) {
        if (project.website) {
          logger.info(`Attempting direct email extraction from website for ${project.name}`);
          const emailData = await this.scrapeWebsiteEmails(project.website);
          
          if (emailData && emailData.emails.length > 0) {
            enrichedData.contacts = emailData.emails;
            enrichedData.enrichmentSources.push('website-email-scraping');
            enrichedData.fallbackAttempts++;
            
            logger.success(`Found ${emailData.emails.length} emails via direct website scraping`);
          }
        }
      }

      // Strategy 4: Enhance existing social media links
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
          
          logger.success(`Enhanced social media data for ${project.name}`);
        }
      }

      const duration = Date.now() - startTime;
      enrichedData.enrichmentDuration = duration;
      
      logger.info(`Social fallback enrichment completed for ${project.name} in ${duration}ms with ${enrichedData.fallbackAttempts} strategies`);
      
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