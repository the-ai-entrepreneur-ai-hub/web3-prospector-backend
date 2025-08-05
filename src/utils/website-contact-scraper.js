const axios = require('axios');
const cheerio = require('cheerio');
const { createLogger } = require('./logger');

/**
 * Website Contact Scraper - Fallback for missing contacts
 * 
 * When Snovio enrichment fails to find contacts, this scraper:
 * 1. Scrapes the project website directly for contact information
 * 2. Looks for email addresses in common contact pages
 * 3. Extracts team member information and LinkedIn profiles
 * 4. Finds social media handles for additional contact methods
 */

class WebsiteContactScraper {
  constructor() {
    this.logger = createLogger('WebsiteContactScraper');
    this.stats = {
      websitesProcessed: 0,
      contactsFound: 0,
      emailsFound: 0,
      socialHandlesFound: 0,
      errors: 0,
      startTime: Date.now()
    };
  }

  /**
   * Main scraping function - extracts all contact information from a website
   */
  async scrapeWebsiteContacts(websiteUrl, projectName = 'Unknown') {
    const startTime = Date.now();
    this.stats.websitesProcessed++;
    
    this.logger.info(`Starting website contact scraping for ${projectName}: ${websiteUrl}`);
    
    try {
      const contactData = {
        emails: [],
        socialHandles: {},
        teamMembers: [],
        contactPages: [],
        confidence: 0,
        source: 'website-scraping'
      };

      // Step 1: Scrape main page
      const mainPageData = await this.scrapePage(websiteUrl, 'main');
      if (mainPageData) {
        contactData.emails.push(...mainPageData.emails);
        contactData.socialHandles = { ...contactData.socialHandles, ...mainPageData.socials };
        contactData.teamMembers.push(...mainPageData.teamMembers);
      }

      // Step 2: Try sitemap for comprehensive page discovery
      const sitemapPages = await this.discoverPagesFromSitemap(websiteUrl);
      
      // Step 3: Try common contact pages (enhanced list)
      const contactPages = [
        '/contact',
        '/contact-us', 
        '/about',
        '/about-us',
        '/team',
        '/people',
        '/leadership',
        '/founders',
        '/company',
        '/who-we-are',
        '/press',
        '/media',
        '/support',
        '/help',
        '/info',
        '/impressum', // German
        '/de/impressum',
        '/privacy',
        '/legal',
        '/imprint',
        ...sitemapPages.slice(0, 10) // Add up to 10 pages from sitemap
      ];

      for (const pagePath of contactPages.slice(0, 3)) { // Limit to 3 pages for speed
        try {
          const contactPageUrl = new URL(pagePath, websiteUrl).href;
          const pageData = await this.scrapePage(contactPageUrl, `contact-${pagePath}`);
          
          if (pageData) {
            contactData.emails.push(...pageData.emails);
            contactData.socialHandles = { ...contactData.socialHandles, ...pageData.socials };
            contactData.teamMembers.push(...pageData.teamMembers);
            contactData.contactPages.push(pagePath);
          }
          
          // Small delay between requests
          await new Promise(resolve => setTimeout(resolve, 500));
          
        } catch (error) {
          this.logger.debug(`Contact page ${pagePath} not accessible: ${error.message}`);
        }
      }

      // Deduplicate emails
      const uniqueEmails = [...new Set(contactData.emails.map(e => e.email.toLowerCase()))]
        .map(email => ({ 
          email, 
          source: 'website-scraping',
          confidence: this.calculateEmailConfidence(email, websiteUrl)
        }))
        .filter(e => this.isValidEmail(e.email));

      contactData.emails = uniqueEmails;

      // Calculate overall confidence
      contactData.confidence = this.calculateOverallConfidence(contactData);

      // Update statistics
      this.stats.contactsFound += uniqueEmails.length > 0 ? 1 : 0;
      this.stats.emailsFound += uniqueEmails.length;
      this.stats.socialHandlesFound += Object.keys(contactData.socialHandles).length;

      const duration = Date.now() - startTime;
      
      if (uniqueEmails.length > 0 || Object.keys(contactData.socialHandles).length > 0) {
        this.logger.success(`✓ Found ${uniqueEmails.length} emails and ${Object.keys(contactData.socialHandles).length} social handles for ${projectName} in ${duration}ms`);
        return contactData;
      } else {
        this.logger.debug(`No contacts found for ${projectName} on website`);
        return null;
      }

    } catch (error) {
      this.stats.errors++;
      this.logger.error(`Website scraping failed for ${projectName}: ${error.message}`);
      return null;
    }
  }

  /**
   * Scrape a single page for contact information
   */
  async scrapePage(url, pageType = 'unknown') {
    try {
      this.logger.debug(`Scraping ${pageType} page: ${url}`);

      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive'
        }
      });

      const $ = cheerio.load(response.data);
      const pageData = {
        emails: [],
        socials: {},
        teamMembers: []
      };

      // Extract emails from various sources
      const emails = new Set();
      
      // 1. Extract from mailto links
      $('a[href^="mailto:"]').each((_, element) => {
        const href = $(element).attr('href');
        const email = href.replace('mailto:', '').split('?')[0]; // Remove query params
        if (this.isValidEmail(email)) {
          emails.add(email.toLowerCase());
        }
      });
      
      // 2. Extract from text using regex
      const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
      const pageText = $.text();
      const emailMatches = pageText.match(emailRegex) || [];
      
      emailMatches.forEach(email => {
        if (this.isValidEmail(email)) {
          emails.add(email.toLowerCase());
        }
      });
      
      // 3. Decode obfuscated emails
      const obfuscatedEmails = this.extractObfuscatedEmails($, response.data);
      obfuscatedEmails.forEach(email => {
        if (this.isValidEmail(email)) {
          emails.add(email.toLowerCase());
        }
      });
      
      // 4. Extract from JSON-LD schema
      const jsonLdEmails = this.extractEmailsFromJsonLd($);
      jsonLdEmails.forEach(email => {
        if (this.isValidEmail(email)) {
          emails.add(email.toLowerCase());
        }
      });
      
      // Convert set to array with metadata
      Array.from(emails).forEach(email => {
        pageData.emails.push({ email, pageType });
      });

      // Extract social media links
      $('a[href]').each((_, element) => {
        const href = $(element).attr('href');
        const text = $(element).text().trim();
        
        if (href) {
          const social = this.extractSocialHandle(href, text);
          if (social) {
            pageData.socials[social.platform.toLowerCase()] = social;
          }
        }
      });

      // Extract team members and decision makers
      const teamMembers = this.extractTeamMembers($);
      pageData.teamMembers.push(...teamMembers);
      
      // Extract JSON-LD Person/Organization data
      const jsonLdPeople = this.extractPeopleFromJsonLd($);
      pageData.teamMembers.push(...jsonLdPeople);

      this.logger.debug(`Page ${pageType}: Found ${pageData.emails.length} emails, ${Object.keys(pageData.socials).length} socials, ${pageData.teamMembers.length} team members`);
      
      return pageData;

    } catch (error) {
      this.logger.debug(`Failed to scrape page ${url}: ${error.message}`);
      return null;
    }
  }

  /**
   * Extract social media handle from URL
   */
  extractSocialHandle(url, linkText = '') {
    const urlLower = url.toLowerCase();
    
    // Twitter/X
    if (urlLower.includes('twitter.com') || urlLower.includes('x.com')) {
      const match = url.match(/(?:twitter\.com|x\.com)\/([^\/\?#]+)/i);
      if (match && match[1] && !match[1].includes('intent') && !match[1].includes('share')) {
        return {
          platform: 'Twitter',
          handle: '@' + match[1],
          url: url,
          linkText
        };
      }
    }
    
    // LinkedIn
    else if (urlLower.includes('linkedin.com')) {
      const companyMatch = url.match(/linkedin\.com\/company\/([^\/\?#]+)/i);
      const personalMatch = url.match(/linkedin\.com\/in\/([^\/\?#]+)/i);
      
      if (companyMatch && companyMatch[1]) {
        return {
          platform: 'LinkedIn',
          handle: companyMatch[1],
          url: url,
          type: 'company',
          linkText
        };
      } else if (personalMatch && personalMatch[1]) {
        return {
          platform: 'LinkedIn',
          handle: personalMatch[1],
          url: url,
          type: 'personal',
          linkText
        };
      }
    }
    
    // Telegram
    else if (urlLower.includes('t.me') || urlLower.includes('telegram')) {
      const match = url.match(/t\.me\/([^\/\?#]+)/i);
      if (match && match[1]) {
        return {
          platform: 'Telegram',
          handle: '@' + match[1],
          url: url,
          linkText
        };
      }
    }
    
    // Discord
    else if (urlLower.includes('discord')) {
      return {
        platform: 'Discord',
        url: url,
        linkText
      };
    }
    
    // GitHub
    else if (urlLower.includes('github.com')) {
      const match = url.match(/github\.com\/([^\/\?#]+)/i);
      if (match && match[1]) {
        return {
          platform: 'GitHub',
          handle: match[1],
          url: url,
          linkText
        };
      }
    }
    
    // Medium
    else if (urlLower.includes('medium.com')) {
      const match = url.match(/medium\.com\/(@[^\/\?#]+)/i);
      if (match && match[1]) {
        return {
          platform: 'Medium',
          handle: match[1],
          url: url,
          linkText
        };
      }
    }
    
    return null;
  }

  /**
   * Extract name from element context
   */
  extractNameFromElement(element) {
    // Try various ways to find the name
    const name = element.text().trim() ||
                 element.attr('title') ||
                 element.attr('alt') ||
                 element.closest('.member, .profile, .bio').find('h1, h2, h3, h4, .name').first().text().trim() ||
                 element.parent().text().trim();
    
    return name && name.length > 2 ? name : null;
  }

  /**
   * Extract role from element context
   */
  extractRoleFromElement(element) {
    const roleSelectors = ['.role', '.title', '.position', '.job-title', '.designation'];
    let role = '';
    
    for (const selector of roleSelectors) {
      const roleElement = element.closest('.member, .profile, .bio').find(selector).first();
      if (roleElement.length) {
        role = roleElement.text().trim();
        break;
      }
    }
    
    return role;
  }

  /**
   * Validate email format and filter out common fake emails
   */
  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidDomains = ['example.com', 'test.com', 'domain.com', 'email.com'];
    const invalidPrefixes = ['no-reply', 'noreply', 'do-not-reply', 'support', 'info'];
    
    if (!emailRegex.test(email)) return false;
    
    const [prefix, domain] = email.toLowerCase().split('@');
    
    // Check for invalid domains
    if (invalidDomains.includes(domain)) return false;
    
    // Check for generic prefixes
    if (invalidPrefixes.includes(prefix)) return false;
    
    return true;
  }

  /**
   * Calculate confidence score for an email
   */
  calculateEmailConfidence(email, websiteUrl) {
    const domain = new URL(websiteUrl).hostname.replace('www.', '');
    const emailDomain = email.split('@')[1];
    
    // Higher confidence if email domain matches website domain
    if (emailDomain === domain) return 0.9;
    
    // Medium confidence for common business email patterns
    if (email.includes('contact') || email.includes('hello') || email.includes('info')) return 0.7;
    
    // Lower confidence for other emails
    return 0.5;
  }

  /**
   * Discover pages from sitemap.xml
   */
  async discoverPagesFromSitemap(websiteUrl) {
    try {
      const sitemapUrls = [
        new URL('/sitemap.xml', websiteUrl).href,
        new URL('/sitemap_index.xml', websiteUrl).href,
        new URL('/sitemap.txt', websiteUrl).href
      ];
      
      for (const sitemapUrl of sitemapUrls) {
        try {
          const response = await axios.get(sitemapUrl, { timeout: 10000 });
          const $ = cheerio.load(response.data, { xmlMode: true });
          
          const pages = [];
          $('url loc').each((_, element) => {
            const url = $(element).text();
            if (url && (url.includes('/team') || url.includes('/about') || 
                       url.includes('/contact') || url.includes('/people') ||
                       url.includes('/leadership') || url.includes('/press'))) {
              const path = new URL(url).pathname;
              pages.push(path);
            }
          });
          
          if (pages.length > 0) {
            this.logger.debug(`Found ${pages.length} relevant pages in sitemap`);
            return pages;
          }
        } catch (error) {
          this.logger.debug(`Sitemap ${sitemapUrl} not accessible`);
        }
      }
      
      return [];
    } catch (error) {
      this.logger.debug(`Sitemap discovery failed: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Extract obfuscated emails from various encoding schemes
   */
  extractObfuscatedEmails($, html) {
    const emails = [];
    
    // 1. Cloudflare email protection
    const cfEmailRegex = /data-cfemail="([a-f0-9]+)"/gi;
    let match;
    while ((match = cfEmailRegex.exec(html)) !== null) {
      const encoded = match[1];
      const decoded = this.decodeCloudflareEmail(encoded);
      if (decoded) emails.push(decoded);
    }
    
    // 2. Character entity encoded emails
    const entityRegex = /(?:&#[0-9]+;|&[a-z]+;)+@(?:&#[0-9]+;|&[a-z]+;|[a-z0-9.-])+/gi;
    while ((match = entityRegex.exec(html)) !== null) {
      const decoded = $('<div>').html(match[0]).text();
      if (this.isValidEmail(decoded)) emails.push(decoded);
    }
    
    // 3. JavaScript-based obfuscation (simple patterns)
    const jsEmailRegex = /(['"])([a-z0-9._%+-]+)\1\s*\+\s*['"]@['"]\s*\+\s*['"]([a-z0-9.-]+\.[a-z]{2,})['"]/gi;
    while ((match = jsEmailRegex.exec(html)) !== null) {
      const email = match[2] + '@' + match[3];
      if (this.isValidEmail(email)) emails.push(email);
    }
    
    return emails;
  }
  
  /**
   * Decode Cloudflare email protection
   */
  decodeCloudflareEmail(encodedString) {
    try {
      const key = parseInt(encodedString.substr(0, 2), 16);
      let decoded = '';
      for (let i = 2; i < encodedString.length; i += 2) {
        const charCode = parseInt(encodedString.substr(i, 2), 16) ^ key;
        decoded += String.fromCharCode(charCode);
      }
      return decoded;
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Extract emails from JSON-LD structured data
   */
  extractEmailsFromJsonLd($) {
    const emails = [];
    
    $('script[type="application/ld+json"]').each((_, element) => {
      try {
        const jsonData = JSON.parse($(element).html());
        const extractFromObject = (obj) => {
          if (typeof obj !== 'object' || obj === null) return;
          
          // Handle arrays
          if (Array.isArray(obj)) {
            obj.forEach(extractFromObject);
            return;
          }
          
          // Extract email from common fields
          if (obj.email && typeof obj.email === 'string') {
            emails.push(obj.email);
          }
          
          // Extract from contactPoint
          if (obj.contactPoint) {
            if (Array.isArray(obj.contactPoint)) {
              obj.contactPoint.forEach(cp => {
                if (cp.email) emails.push(cp.email);
              });
            } else if (obj.contactPoint.email) {
              emails.push(obj.contactPoint.email);
            }
          }
          
          // Recursively search nested objects
          Object.values(obj).forEach(extractFromObject);
        };
        
        extractFromObject(jsonData);
      } catch (error) {
        // Invalid JSON, skip
      }
    });
    
    return emails;
  }
  
  /**
   * Extract team members with enhanced detection
   */
  extractTeamMembers($) {
    const teamMembers = [];
    
    // Enhanced team selectors
    const teamSelectors = [
      '.team', '.about-team', '.our-team', '.founders', '.co-founders',
      '.leadership', '.advisors', '.board', '.management',
      '[id*="team"]', '[class*="team"]', '[class*="founder"]',
      '.bio', '.profile', '.member', '.staff', '.employee',
      '.person', '.people', '.executive', '.director'
    ];

    teamSelectors.forEach(selector => {
      $(selector).each((_, element) => {
        const teamSection = $(element);
        
        // Look for LinkedIn profiles in team sections
        teamSection.find('a[href*="linkedin.com/in/"]').each((_, link) => {
          const linkedinUrl = $(link).attr('href');
          const name = this.extractNameFromElement($(link)) || 'Unknown';
          const role = this.extractRoleFromElement($(link)) || '';
          const decisionMakerScore = this.calculateDecisionMakerScore(role);
          
          if (linkedinUrl) {
            teamMembers.push({
              name,
              role,
              linkedin: linkedinUrl,
              decisionMakerScore,
              source: 'team-section'
            });
          }
        });
        
        // Extract names and roles from team cards/sections
        teamSection.find('.name, .member-name, h3, h4, h5').each((_, nameElement) => {
          const name = $(nameElement).text().trim();
          if (name && name.length > 2 && !name.includes('@')) {
            const role = this.findRoleNearElement($(nameElement));
            const decisionMakerScore = this.calculateDecisionMakerScore(role);
            
            // Generate potential emails
            const potentialEmails = this.generateEmailPatterns(name, this.extractDomainFromUrl(window?.location?.href || ''));
            
            teamMembers.push({
              name,
              role,
              decisionMakerScore,
              potentialEmails,
              source: 'team-extraction'
            });
          }
        });
      });
    });
    
    return teamMembers;
  }
  
  /**
   * Extract people from JSON-LD structured data
   */
  extractPeopleFromJsonLd($) {
    const people = [];
    
    $('script[type="application/ld+json"]').each((_, element) => {
      try {
        const jsonData = JSON.parse($(element).html());
        const extractPersons = (obj) => {
          if (typeof obj !== 'object' || obj === null) return;
          
          if (Array.isArray(obj)) {
            obj.forEach(extractPersons);
            return;
          }
          
          // Check if this is a Person schema
          if (obj['@type'] === 'Person' || obj.type === 'Person') {
            const person = {
              name: obj.name || '',
              role: obj.jobTitle || obj.worksFor?.name || '',
              email: obj.email || '',
              linkedin: obj.sameAs?.find(url => url.includes('linkedin.com')) || '',
              decisionMakerScore: this.calculateDecisionMakerScore(obj.jobTitle || ''),
              source: 'json-ld'
            };
            
            if (person.name) people.push(person);
          }
          
          // Check if this is an Organization with employees
          if (obj['@type'] === 'Organization' || obj.type === 'Organization') {
            if (obj.employee && Array.isArray(obj.employee)) {
              obj.employee.forEach(extractPersons);
            }
            if (obj.founder) {
              extractPersons(obj.founder);
            }
          }
          
          // Recursively search nested objects
          Object.values(obj).forEach(extractPersons);
        };
        
        extractPersons(jsonData);
      } catch (error) {
        // Invalid JSON, skip
      }
    });
    
    return people;
  }
  
  /**
   * Calculate decision maker score based on role/title
   */
  calculateDecisionMakerScore(role) {
    if (!role) return 0;
    
    const title = role.toLowerCase();
    
    // C-level executives (highest priority)
    if (title.includes('ceo') || title.includes('chief executive')) return 10;
    if (title.includes('cto') || title.includes('chief technology')) return 9;
    if (title.includes('cfo') || title.includes('chief financial')) return 9;
    if (title.includes('cmo') || title.includes('chief marketing')) return 8;
    if (title.includes('coo') || title.includes('chief operating')) return 8;
    if (title.includes('chief')) return 7;
    
    // Founders (very high priority)
    if (title.includes('founder') || title.includes('co-founder')) return 10;
    
    // VPs and Directors
    if (title.includes('vp ') || title.includes('vice president')) return 6;
    if (title.includes('director')) return 5;
    
    // Department heads
    if (title.includes('head of') || title.includes('lead ')) return 4;
    if (title.includes('manager')) return 3;
    
    // Business development and partnerships
    if (title.includes('business development') || title.includes('partnerships')) return 6;
    if (title.includes('growth')) return 5;
    
    return 1; // Default for any other position
  }
  
  /**
   * Find role text near a name element
   */
  findRoleNearElement(nameElement) {
    const roleSelectors = ['.role', '.title', '.position', '.job-title', '.designation'];
    
    // Try finding role in parent container
    const container = nameElement.closest('.member, .profile, .bio, .person, .team-member');
    
    for (const selector of roleSelectors) {
      const roleElement = container.find(selector).first();
      if (roleElement.length) {
        return roleElement.text().trim();
      }
    }
    
    // Try finding role as next sibling or in nearby elements
    const nextElement = nameElement.next();
    if (nextElement.length && nextElement.text().trim().length < 100) {
      return nextElement.text().trim();
    }
    
    return '';
  }
  
  /**
   * Generate potential email patterns from name and domain
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
   * Extract domain from URL
   */
  extractDomainFromUrl(url) {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch (error) {
      return '';
    }
  }
  
  /**
   * Calculate overall confidence for contact data
   */
  calculateOverallConfidence(contactData) {
    let confidence = 0;
    
    if (contactData.emails.length > 0) {
      const avgEmailConfidence = contactData.emails.reduce((sum, e) => sum + e.confidence, 0) / contactData.emails.length;
      confidence += avgEmailConfidence * 0.7;
    }
    
    if (Object.keys(contactData.socialHandles).length > 0) {
      confidence += 0.2;
    }
    
    if (contactData.teamMembers.length > 0) {
      confidence += 0.1;
      
      // Bonus for decision makers
      const hasDecisionMakers = contactData.teamMembers.some(member => member.decisionMakerScore > 5);
      if (hasDecisionMakers) {
        confidence += 0.1;
      }
    }
    
    return Math.min(confidence, 1.0);
  }

  /**
   * Get scraping statistics
   */
  getStats() {
    const runtime = Date.now() - this.stats.startTime;
    
    return {
      ...this.stats,
      runtime,
      successRate: this.stats.websitesProcessed > 0 ? 
        ((this.stats.websitesProcessed - this.stats.errors) / this.stats.websitesProcessed * 100).toFixed(1) : '0.0',
      avgEmailsPerSite: this.stats.websitesProcessed > 0 ? 
        (this.stats.emailsFound / this.stats.websitesProcessed).toFixed(1) : '0.0'
    };
  }

  /**
   * Log current statistics
   */
  logStats() {
    const stats = this.getStats();
    
    this.logger.info('=== WEBSITE CONTACT SCRAPER STATISTICS ===');
    this.logger.info(`Runtime: ${(stats.runtime / 1000).toFixed(1)}s`);
    this.logger.info(`Websites Processed: ${stats.websitesProcessed}`);
    this.logger.info(`Contacts Found: ${stats.contactsFound}`);
    this.logger.info(`Total Emails Found: ${stats.emailsFound}`);
    this.logger.info(`Social Handles Found: ${stats.socialHandlesFound}`);
    this.logger.info(`Success Rate: ${stats.successRate}%`);
    this.logger.info(`Average Emails per Site: ${stats.avgEmailsPerSite}`);
    this.logger.info(`Errors: ${stats.errors}`);
  }
}

/**
 * Create a website contact scraper instance
 */
function createWebsiteContactScraper() {
  return new WebsiteContactScraper();
}

module.exports = {
  WebsiteContactScraper,
  createWebsiteContactScraper
};