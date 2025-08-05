const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const { createLogger } = require('./logger');
const { createProxyRotator } = require('./proxy');

/**
 * Name Extractor Service
 * 
 * Extracts real employee names from various sources to use with Snov.io v1 API.
 * The v1 API requires actual employee names, not generic placeholders.
 */

class NameExtractor {
  constructor() {
    this.logger = createLogger('NameExtractor');
    this.proxyRotator = createProxyRotator();
    this.extractedNames = new Set(); // Prevent duplicates
  }

  /**
   * Main function to extract all available names for a company
   */
  async extractNames(project) {
    const logger = this.logger;
    logger.info(`Starting name extraction for ${project.name}`);
    
    const names = [];
    
    try {
      // Strategy 1: Extract from company website team pages
      if (project.website) {
        logger.info(`Extracting names from website: ${project.website}`);
        const websiteNames = await this.extractFromWebsite(project.website, project.name);
        names.push(...websiteNames);
        logger.info(`Found ${websiteNames.length} names from website`);
      }

      // Strategy 2: LinkedIn company page employee search
      const domain = this.extractDomainFromUrl(project.website || '');
      if (domain) {
        logger.info(`Extracting names from LinkedIn for ${project.name}`);
        const linkedinNames = await this.extractFromLinkedIn(project.name, domain);
        names.push(...linkedinNames);
        logger.info(`Found ${linkedinNames.length} names from LinkedIn`);
      }

      // Strategy 3: GitHub organization members
      if (project.github) {
        logger.info(`Extracting names from GitHub: ${project.github}`);
        const githubNames = await this.extractFromGitHub(project.github);
        names.push(...githubNames);
        logger.info(`Found ${githubNames.length} names from GitHub`);
      }

      // Deduplicate and sort by decision maker score
      const uniqueNames = this.deduplicateAndScore(names);
      
      logger.info(`Total unique names extracted: ${uniqueNames.length}`);
      return uniqueNames;

    } catch (error) {
      logger.error(`Name extraction failed for ${project.name}: ${error.message}`);
      return [];
    }
  }

  /**
   * Extract names from company website team/about pages
   */
  async extractFromWebsite(websiteUrl, companyName) {
    const names = [];
    
    try {
      // Common team page URLs to check
      const teamUrls = [
        `${websiteUrl}/team`,
        `${websiteUrl}/about`,
        `${websiteUrl}/about-us`,
        `${websiteUrl}/leadership`,
        `${websiteUrl}/founders`,
        `${websiteUrl}/management`,
        `${websiteUrl}/company/team`,
        `${websiteUrl}/our-team`
      ];

      // Also scrape main page for team information
      teamUrls.unshift(websiteUrl);

      for (const url of teamUrls) {
        try {
          const pageNames = await this.scrapePageForNames(url);
          names.push(...pageNames);
          
          // Limit to avoid excessive requests
          if (names.length >= 20) break;
          
        } catch (error) {
          // Continue to next URL if this one fails
          continue;
        }
      }

    } catch (error) {
      this.logger.debug(`Website name extraction failed: ${error.message}`);
    }

    return names;
  }

  /**
   * Scrape a single page for team member names
   */
  async scrapePageForNames(url) {
    const names = [];
    
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      const $ = cheerio.load(response.data);
      
      // Look for common team member patterns
      const teamSelectors = [
        '.team-member',
        '.team-card', 
        '.member',
        '.founder',
        '.leadership',
        '.staff',
        '.employee',
        '[class*="team"]',
        '[class*="member"]',
        '[class*="founder"]',
        '[class*="leadership"]'
      ];

      // Extract names from team sections
      teamSelectors.forEach(selector => {
        $(selector).each((i, element) => {
          const name = this.extractNameFromElement($, element);
          if (name) {
            const role = this.extractRoleFromElement($, element);
            names.push({
              name: name,
              role: role || 'Team Member',
              source: 'website-team-page',
              url: url,
              decisionMakerScore: this.calculateDecisionMakerScore(role)
            });
          }
        });
      });

      // Also check for JSON-LD structured data
      $('script[type="application/ld+json"]').each((i, element) => {
        try {
          const jsonData = JSON.parse($(element).html());
          const structuredNames = this.extractNamesFromJsonLD(jsonData);
          names.push(...structuredNames);
        } catch (error) {
          // Invalid JSON, skip
        }
      });

      // Look for specific founder/leadership mentions in text
      const text = $('body').text();
      const foundersFromText = this.extractFoundersFromText(text, url);
      names.push(...foundersFromText);

    } catch (error) {
      // Page not accessible, skip
    }

    return names;
  }

  /**
   * Extract name from a DOM element
   */
  extractNameFromElement($, element) {
    const $el = $(element);
    
    // Try various selectors for name
    const nameSelectors = [
      '.name',
      '.member-name', 
      '.team-name',
      '.founder-name',
      'h1, h2, h3, h4, h5, h6',
      '.title',
      '[class*="name"]'
    ];

    for (const selector of nameSelectors) {
      const nameEl = $el.find(selector).first();
      if (nameEl.length) {
        const name = nameEl.text().trim();
        if (this.isValidName(name)) {
          return this.cleanName(name);
        }
      }
    }

    // Fallback: check element text directly
    const text = $el.text().trim();
    const potentialName = text.split('\n')[0].trim();
    
    if (this.isValidName(potentialName)) {
      return this.cleanName(potentialName);
    }

    return null;
  }

  /**
   * Extract role from a DOM element
   */
  extractRoleFromElement($, element) {
    const $el = $(element);
    
    const roleSelectors = [
      '.role',
      '.position',
      '.title',
      '.job-title',
      '[class*="role"]',
      '[class*="position"]',
      '[class*="title"]'
    ];

    for (const selector of roleSelectors) {
      const roleEl = $el.find(selector).first();
      if (roleEl.length) {
        return roleEl.text().trim();
      }
    }

    // Check element text for common role patterns
    const text = $el.text();
    const roleMatch = text.match(/(CEO|CTO|CFO|COO|founder|co-founder|president|director|head of|VP|vice president|chief|lead|manager)/i);
    
    return roleMatch ? roleMatch[1] : 'Team Member';
  }

  /**
   * Extract names from JSON-LD structured data
   */
  extractNamesFromJsonLD(jsonData) {
    const names = [];
    
    try {
      // Handle arrays of structured data
      const dataArray = Array.isArray(jsonData) ? jsonData : [jsonData];
      
      dataArray.forEach(data => {
        // Look for Organization with employee data
        if (data['@type'] === 'Organization' && data.employee) {
          const employees = Array.isArray(data.employee) ? data.employee : [data.employee];
          
          employees.forEach(employee => {
            if (employee.name) {
              names.push({
                name: this.cleanName(employee.name),
                role: employee.jobTitle || 'Employee',
                source: 'website-json-ld',
                decisionMakerScore: this.calculateDecisionMakerScore(employee.jobTitle)
              });
            }
          });
        }

        // Look for Person data
        if (data['@type'] === 'Person' && data.name) {
          names.push({
            name: this.cleanName(data.name),
            role: data.jobTitle || 'Team Member',
            source: 'website-json-ld',
            decisionMakerScore: this.calculateDecisionMakerScore(data.jobTitle)
          });
        }
      });

    } catch (error) {
      // Invalid structured data, skip
    }

    return names;
  }

  /**
   * Extract founder names from page text using patterns
   */
  extractFoundersFromText(text, url) {
    const names = [];
    
    // Common founder patterns
    const founderPatterns = [
      /(?:(co-)?founded by|founder[s]?[:\s]+)([A-Z][a-z]+ [A-Z][a-z]+(?:\s+and\s+[A-Z][a-z]+ [A-Z][a-z]+)?)/gi,
      /(?:CEO|CTO|CFO)[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/gi,
      /([A-Z][a-z]+ [A-Z][a-z]+)(?:\s+is\s+(?:the\s+)?(?:CEO|CTO|CFO|founder|co-founder))/gi
    ];

    founderPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(text)) !== null && names.length < 10) {
        const name = match[match.length - 1]; // Last capture group is the name
        if (this.isValidName(name)) {
          names.push({
            name: this.cleanName(name),
            role: this.inferRoleFromContext(match[0]),
            source: 'website-text-extraction',
            url: url,
            decisionMakerScore: this.calculateDecisionMakerScore(match[0])
          });
        }
      }
    });

    return names;
  }

  /**
   * Extract names from LinkedIn company searches
   */
  async extractFromLinkedIn(companyName, domain) {
    const names = [];
    
    try {
      // Use browser automation for LinkedIn (if needed)
      // For now, use search-based approach
      const searchQueries = [
        `"${companyName}" CEO site:linkedin.com/in`,
        `"${companyName}" CTO site:linkedin.com/in`,
        `"${companyName}" founder site:linkedin.com/in`,
        `"${domain}" CEO site:linkedin.com/in`,
        `"${domain}" founder site:linkedin.com/in`
      ];

      for (const query of searchQueries) {
        try {
          const searchResults = await this.searchGoogle(query);
          
          for (const result of searchResults.slice(0, 5)) {
            if (result.url.includes('linkedin.com/in/')) {
              const name = this.extractNameFromLinkedInSearchResult(result.title);
              if (name) {
                names.push({
                  name: name,
                  role: this.extractRoleFromLinkedInSearchResult(result.title),
                  source: 'linkedin-search',
                  url: result.url,
                  decisionMakerScore: this.calculateDecisionMakerScore(result.title)
                });
              }
            }
          }
          
          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          continue;
        }

        if (names.length >= 10) break;
      }

    } catch (error) {
      this.logger.debug(`LinkedIn name extraction failed: ${error.message}`);
    }

    return names;
  }

  /**
   * Extract names from GitHub organization
   */
  async extractFromGitHub(githubUrl) {
    const names = [];
    
    try {
      // Extract org name from URL
      const orgMatch = githubUrl.match(/github\.com\/([^\/]+)/);
      if (!orgMatch) return names;
      
      const orgName = orgMatch[1];
      
      // Get organization members via GitHub API
      const response = await axios.get(`https://api.github.com/orgs/${orgName}/members`, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Web3-Prospector-Bot',
          'Accept': 'application/vnd.github.v3+json'
        }
      });

      for (const member of response.data.slice(0, 10)) {
        // Get member details
        try {
          const memberResponse = await axios.get(member.url, {
            timeout: 5000,
            headers: {
              'User-Agent': 'Web3-Prospector-Bot',
              'Accept': 'application/vnd.github.v3+json'  
            }
          });

          const memberData = memberResponse.data;
          if (memberData.name && this.isValidName(memberData.name)) {
            names.push({
              name: this.cleanName(memberData.name),
              role: 'Developer',
              source: 'github-org',
              url: memberData.html_url,
              decisionMakerScore: this.calculateDecisionMakerScore('Developer')
            });
          }

          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error) {
          continue;
        }
      }

    } catch (error) {
      this.logger.debug(`GitHub name extraction failed: ${error.message}`);
    }

    return names;
  }

  /**
   * Google search helper
   */
  async searchGoogle(query) {
    try {
      const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: {
          key: process.env.GOOGLE_API_KEY,
          cx: process.env.GOOGLE_SEARCH_ENGINE_ID,
          q: query,
          num: 5
        },
        timeout: 10000
      });

      return response.data.items || [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Utility functions
   */
  extractNameFromLinkedInSearchResult(title) {
    // LinkedIn search results usually format as "Name - Role at Company"
    const match = title.match(/^([^-|]+)(?:\s*[-|]\s*)/);
    if (match) {
      const name = match[1].trim();
      return this.isValidName(name) ? this.cleanName(name) : null;
    }
    return null;
  }

  extractRoleFromLinkedInSearchResult(title) {
    const match = title.match(/[-|]\s*([^-|]+)\s*(?:at|@)/i);
    return match ? match[1].trim() : 'Professional';
  }

  inferRoleFromContext(context) {
    const lowerContext = context.toLowerCase();
    if (lowerContext.includes('ceo')) return 'CEO';
    if (lowerContext.includes('cto')) return 'CTO';
    if (lowerContext.includes('cfo')) return 'CFO';
    if (lowerContext.includes('founder')) return 'Founder';
    if (lowerContext.includes('co-founder')) return 'Co-Founder';
    return 'Executive';
  }

  isValidName(name) {
    if (!name || typeof name !== 'string') return false;
    
    const cleaned = name.trim();
    
    // Must have at least first and last name
    const words = cleaned.split(/\s+/);
    if (words.length < 2) return false;
    
    // Each word should start with capital letter
    if (!words.every(word => /^[A-Z][a-z]+/.test(word))) return false;
    
    // Reasonable length limits
    if (cleaned.length < 4 || cleaned.length > 50) return false;
    
    // Avoid common false positives
    const blacklist = ['Team Member', 'Our Team', 'Meet The', 'About Us', 'Contact Us', 'Read More'];
    if (blacklist.some(phrase => cleaned.includes(phrase))) return false;
    
    return true;
  }

  cleanName(name) {
    return name.replace(/[^\w\s.-]/g, '').trim();
  }

  calculateDecisionMakerScore(roleText) {
    if (!roleText) return 1;
    
    const text = roleText.toLowerCase();
    
    // CEO, Founder get highest scores
    if (text.includes('ceo') || text.includes('founder') || text.includes('president')) return 10;
    if (text.includes('cto') || text.includes('cfo') || text.includes('coo')) return 9;
    if (text.includes('vp') || text.includes('vice president') || text.includes('director')) return 8;
    if (text.includes('head of') || text.includes('lead') || text.includes('chief')) return 7;
    if (text.includes('manager') || text.includes('senior')) return 5;
    
    return 3; // Default score
  }

  extractDomainFromUrl(url) {
    if (!url) return '';
    
    try {
      let domain = url.replace(/^https?:\/\//, '');
      domain = domain.replace(/^www\./, '');
      domain = domain.split('/')[0];
      domain = domain.split(':')[0];
      return domain.toLowerCase();
    } catch (error) {
      return url;
    }
  }

  deduplicateAndScore(names) {
    // Use Map to deduplicate by name while keeping highest scoring entry
    const uniqueNames = new Map();
    
    names.forEach(nameObj => {
      const key = nameObj.name.toLowerCase();
      if (!uniqueNames.has(key) || uniqueNames.get(key).decisionMakerScore < nameObj.decisionMakerScore) {
        uniqueNames.set(key, nameObj);
      }
    });
    
    // Convert back to array and sort by decision maker score
    return Array.from(uniqueNames.values())
      .sort((a, b) => b.decisionMakerScore - a.decisionMakerScore)
      .slice(0, 15); // Limit to top 15 names to avoid API overload
  }
}

module.exports = NameExtractor;