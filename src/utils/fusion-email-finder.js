const axios = require('axios');
const cheerio = require('cheerio');
const { createLogger } = require('./logger');

/**
 * Public Data Fusion Engine for Web3 Contact Discovery
 * 
 * Combines GitHub contributor analysis, domain ownership checks, 
 * and LinkedIn profile cross-referencing for maximum contact coverage.
 */

class FusionEmailFinder {
  constructor() {
    this.logger = createLogger('FusionEmailFinder');
    this.stats = {
      projectsProcessed: 0,
      emailsFound: 0,
      githubSuccess: 0,
      whoisSuccess: 0,
      linkedinSuccess: 0,
      startTime: Date.now()
    };
  }

  /**
   * Main fusion function - combines all discovery methods
   */
  async findFounderEmail(projectName, domain, githubUrl = null) {
    const startTime = Date.now();
    this.stats.projectsProcessed++;

    this.logger.info(`🚀 Starting fusion email discovery for ${projectName} (${domain})`);

    const results = {
      github: [],
      domain: [],
      linkedin: [],
      pattern: [],
      final: null
    };

    try {
      // Strategy 1: GitHub Contributor Analysis
      if (githubUrl) {
        this.logger.info(`🔍 Analyzing GitHub contributors for ${projectName}`);
        results.github = await this.scrapeGitHubContributors(githubUrl, projectName);
        if (results.github.length > 0) {
          this.stats.githubSuccess++;
          this.logger.info(`✅ Found ${results.github.length} GitHub contributors`);
        }
      }

      // Strategy 2: Domain WHOIS Analysis
      this.logger.info(`🔍 Analyzing domain ownership for ${domain}`);
      results.domain = await this.analyzeDomainOwnership(domain);
      if (results.domain.length > 0) {
        this.stats.whoisSuccess++;
        this.logger.info(`✅ Found ${results.domain.length} domain-related emails`);
      }

      // Strategy 3: LinkedIn Founder Matching
      this.logger.info(`🔍 Searching LinkedIn for ${projectName} founders`);
      results.linkedin = await this.findLinkedInFounders(projectName, domain);
      if (results.linkedin.length > 0) {
        this.stats.linkedinSuccess++;
        this.logger.info(`✅ Found ${results.linkedin.length} LinkedIn founder profiles`);
      }

      // Strategy 4: Smart Email Pattern Construction
      this.logger.info(`🔍 Generating email patterns for ${projectName}`);
      results.pattern = await this.generateEmailPatterns(projectName, domain);
      if (results.pattern.length > 0) {
        this.logger.info(`✅ Generated ${results.pattern.length} email patterns`);
      }

      // Strategy 5: Fusion and Prioritization
      const candidateEmails = this.fuseAndPrioritize(results);
      
      if (candidateEmails.length > 0) {
        results.final = candidateEmails[0];
        this.stats.emailsFound++;
        
        const duration = Date.now() - startTime;
        this.logger.info(`🎯 Fusion discovery complete for ${projectName}: found ${candidateEmails.length} candidates in ${duration}ms`);
        
        return {
          primaryEmail: results.final,
          allCandidates: candidateEmails,
          sources: results,
          confidence: this.calculateConfidence(results.final, results),
          decisionMakerScore: this.calculateDecisionMakerScore(results.final, results)
        };
      } else {
        this.logger.warn(`❌ No valid emails found for ${projectName} using fusion approach`);
        return null;
      }

    } catch (error) {
      this.logger.error(`Fusion discovery failed for ${projectName}: ${error.message}`);
      return null;
    }
  }

  /**
   * Strategy 1: GitHub Contributor Analysis
   */
  async scrapeGitHubContributors(githubUrl, projectName) {
    const contributors = [];

    try {
      // Extract repo info from URL
      const repoMatch = githubUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
      if (!repoMatch) return contributors;

      const [, owner, repo] = repoMatch;

      // Get contributors via GitHub API
      const contributorsResponse = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/contributors`,
        {
          headers: {
            'User-Agent': 'Web3-Prospector-Bot',
            'Accept': 'application/vnd.github.v3+json'
          },
          timeout: 10000
        }
      );

      // Get detailed info for top contributors
      for (const contributor of contributorsResponse.data.slice(0, 5)) {
        try {
          const userResponse = await axios.get(contributor.url, {
            headers: {
              'User-Agent': 'Web3-Prospector-Bot',
              'Accept': 'application/vnd.github.v3+json'
            },
            timeout: 5000
          });

          const userData = userResponse.data;
          
          // Extract email if available
          let email = userData.email;
          
          // Generate likely email patterns if no public email
          if (!email && userData.login) {
            const username = userData.login.toLowerCase();
            email = `${username}@gmail.com`;
          }

          if (email && this.isValidEmail(email)) {
            contributors.push({
              name: userData.name || userData.login,
              email: email,
              username: userData.login,
              contributions: contributor.contributions,
              source: 'github-api',
              isTopContributor: contributor.contributions > 10,
              decisionMakerScore: this.calculateGitHubDecisionMakerScore(contributor.contributions, userData.login)
            });
          }

          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error) {
          continue;
        }
      }

      // Also check commits for additional emails
      const commitsResponse = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/commits`,
        {
          headers: {
            'User-Agent': 'Web3-Prospector-Bot',
            'Accept': 'application/vnd.github.v3+json'
          },
          timeout: 10000
        }
      );

      // Extract emails from commit authors
      const commitEmails = new Set();
      commitsResponse.data.slice(0, 20).forEach(commit => {
        if (commit.commit.author.email && this.isValidEmail(commit.commit.author.email)) {
          commitEmails.add(commit.commit.author.email);
        }
      });

      // Add commit emails as additional contributors
      commitEmails.forEach(email => {
        if (!contributors.find(c => c.email === email)) {
          contributors.push({
            name: 'Commit Author',
            email: email,
            source: 'github-commits',
            contributions: 1,
            decisionMakerScore: 6
          });
        }
      });

    } catch (error) {
      this.logger.debug(`GitHub contributor analysis failed: ${error.message}`);
    }

    return contributors;
  }

  /**
   * Strategy 2: Domain WHOIS Analysis
   */
  async analyzeDomainOwnership(domain) {
    const domainEmails = [];

    try {
      // Try multiple WHOIS approaches
      const whoisSources = [
        `https://www.whois.com/whois/${domain}`,
        `https://who.is/whois/${domain}`
      ];

      for (const whoisUrl of whoisSources) {
        try {
          const response = await axios.get(whoisUrl, {
            timeout: 10000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });

          const $ = cheerio.load(response.data);
          const text = $('body').text();

          // Extract emails from WHOIS data
          const emailMatches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
          
          if (emailMatches) {
            emailMatches.forEach(email => {
              if (this.isValidEmail(email) && !this.isPrivacyProtectedEmail(email)) {
                domainEmails.push({
                  email: email.toLowerCase(),
                  source: 'whois-data',
                  type: this.categorizeWhoisEmail(email),
                  decisionMakerScore: this.calculateWhoisDecisionMakerScore(email)
                });
              }
            });
          }

          break; // Success, no need to try other sources

        } catch (error) {
          continue;
        }
      }

      // Also check common admin email patterns
      const adminPatterns = [
        `admin@${domain}`,
        `support@${domain}`,
        `contact@${domain}`,
        `info@${domain}`,
        `hello@${domain}`,
        `team@${domain}`,
        `founder@${domain}`,
        `ceo@${domain}`
      ];

      // Verify which admin emails actually exist (simplified check)
      for (const adminEmail of adminPatterns) {
        domainEmails.push({
          email: adminEmail,
          source: 'domain-pattern',
          type: 'admin',
          decisionMakerScore: this.calculateAdminEmailScore(adminEmail),
          verified: false // Would need MX record check to verify
        });
      }

    } catch (error) {
      this.logger.debug(`Domain ownership analysis failed: ${error.message}`);
    }

    return domainEmails;
  }

  /**
   * Strategy 3: LinkedIn Founder Matching
   */
  async findLinkedInFounders(projectName, domain) {
    const linkedinProfiles = [];

    try {
      // Search for LinkedIn profiles using Google
      const searchQueries = [
        `site:linkedin.com/in "${projectName}" AND (Founder OR "Co-Founder" OR CEO)`,
        `site:linkedin.com/in "${domain}" AND (Founder OR CEO)`,
        `"${projectName}" LinkedIn Founder`,
        `"${domain}" LinkedIn CEO`
      ];

      for (const query of searchQueries) {
        try {
          const searchResults = await this.searchGoogle(query);
          
          for (const result of searchResults.slice(0, 3)) {
            if (result.url.includes('linkedin.com/in/')) {
              const profile = await this.extractLinkedInProfile(result);
              if (profile && profile.email) {
                linkedinProfiles.push(profile);
              }
            }
          }

          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
          continue;
        }

        if (linkedinProfiles.length >= 5) break; // Limit results
      }

    } catch (error) {
      this.logger.debug(`LinkedIn founder search failed: ${error.message}`);
    }

    return linkedinProfiles;
  }

  /**
   * Strategy 4: Smart Email Pattern Construction
   */
  async generateEmailPatterns(projectName, domain) {
    const patterns = [];

    try {
      // Extract potential founder names from project name
      const nameVariations = this.extractNameVariations(projectName);

      // Common email patterns
      const patternTemplates = [
        '{firstname}@{domain}',
        '{lastname}@{domain}',
        '{firstname}.{lastname}@{domain}',
        '{firstname}{lastname}@{domain}',
        '{firstname}_{lastname}@{domain}',
        'founder@{domain}',
        'ceo@{domain}',
        'admin@{domain}'
      ];

      nameVariations.forEach(name => {
        const firstname = name.first?.toLowerCase();
        const lastname = name.last?.toLowerCase();

        patternTemplates.forEach(template => {
          let email = template
            .replace('{firstname}', firstname || 'founder')
            .replace('{lastname}', lastname || 'admin')
            .replace('{domain}', domain);

          if (this.isValidEmail(email)) {
            patterns.push({
              email: email,
              source: 'pattern-generation',
              pattern: template,
              confidence: this.calculatePatternConfidence(template, name),
              decisionMakerScore: this.calculatePatternDecisionMakerScore(template)
            });
          }
        });
      });

    } catch (error) {
      this.logger.debug(`Email pattern generation failed: ${error.message}`);
    }

    return patterns;
  }

  /**
   * Strategy 5: Fusion and Prioritization
   */
  fuseAndPrioritize(results) {
    const allEmails = new Map(); // Use Map to deduplicate and track sources

    // Collect all emails with source tracking
    [...results.github, ...results.domain, ...results.linkedin, ...results.pattern]
      .forEach(item => {
        if (item.email && this.isValidEmail(item.email)) {
          const email = item.email.toLowerCase();
          
          if (!allEmails.has(email)) {
            allEmails.set(email, {
              email: email,
              sources: [],
              totalScore: 0,
              confidence: 0
            });
          }

          const emailData = allEmails.get(email);
          emailData.sources.push(item.source);
          emailData.totalScore += (item.decisionMakerScore || 5);
          emailData.confidence += (item.confidence || 0.7);
        }
      });

    // Convert to array and prioritize
    const prioritizedEmails = Array.from(allEmails.values())
      .map(emailData => ({
        ...emailData,
        confidence: emailData.confidence / emailData.sources.length,
        sourceCount: emailData.sources.length
      }))
      .sort((a, b) => {
        // Prioritize by: source count, total score, then confidence
        if (a.sourceCount !== b.sourceCount) {
          return b.sourceCount - a.sourceCount;
        }
        if (a.totalScore !== b.totalScore) {
          return b.totalScore - a.totalScore;
        }
        return b.confidence - a.confidence;
      })
      .map(emailData => emailData.email);

    return prioritizedEmails;
  }

  /**
   * Utility functions
   */
  async searchGoogle(query) {
    try {
      // Note: This would require Google Custom Search API
      // For now, return empty array - you'd need to set up Google API
      if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID) {
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
      }
      return [];
    } catch (error) {
      return [];
    }
  }

  async extractLinkedInProfile(searchResult) {
    // Simplified LinkedIn extraction - would need more sophisticated scraping
    return {
      email: null, // LinkedIn rarely exposes emails publicly
      name: searchResult.title?.split(' - ')[0],
      url: searchResult.url,
      source: 'linkedin-search',
      decisionMakerScore: 9
    };
  }

  extractNameVariations(projectName) {
    const variations = [];
    
    // Simple name extraction patterns
    const words = projectName.replace(/[^a-zA-Z\s]/g, '').split(/\s+/);
    
    if (words.length >= 2) {
      variations.push({
        first: words[0],
        last: words[words.length - 1]
      });
    }

    return variations;
  }

  isValidEmail(email) {
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
  }

  isPrivacyProtectedEmail(email) {
    const privacyDomains = ['whoisguard.com', 'domains.google.com', 'proxy.godaddy.com'];
    return privacyDomains.some(domain => email.includes(domain));
  }

  categorizeWhoisEmail(email) {
    if (email.includes('admin')) return 'admin';
    if (email.includes('support')) return 'support';
    if (email.includes('contact')) return 'contact';
    return 'other';
  }

  calculateGitHubDecisionMakerScore(contributions, username) {
    if (contributions > 100) return 10;
    if (contributions > 50) return 9;
    if (contributions > 20) return 8;
    if (username.includes('founder') || username.includes('admin')) return 9;
    return 7;
  }

  calculateWhoisDecisionMakerScore(email) {
    if (email.includes('admin')) return 8;
    if (email.includes('contact')) return 7;
    if (email.includes('support')) return 5;
    return 6;
  }

  calculateAdminEmailScore(email) {
    if (email.includes('founder') || email.includes('ceo')) return 10;
    if (email.includes('admin')) return 8;
    if (email.includes('contact')) return 7;
    return 6;
  }

  calculatePatternConfidence(template, name) {
    if (template.includes('founder') || template.includes('ceo')) return 0.9;
    if (template.includes('firstname') && name.first) return 0.8;
    return 0.6;
  }

  calculatePatternDecisionMakerScore(template) {
    if (template.includes('founder') || template.includes('ceo')) return 10;
    if (template.includes('admin')) return 8;
    return 6;
  }

  calculateConfidence(email, results) {
    let confidence = 0.5;
    
    if (results.github.find(g => g.email === email)) confidence += 0.3;
    if (results.domain.find(d => d.email === email)) confidence += 0.2;
    if (results.linkedin.find(l => l.email === email)) confidence += 0.4;
    
    return Math.min(confidence, 1.0);
  }

  calculateDecisionMakerScore(email, results) {
    const sources = [
      ...results.github,
      ...results.domain,
      ...results.linkedin,
      ...results.pattern
    ];

    const match = sources.find(s => s.email === email);
    return match ? match.decisionMakerScore : 5;
  }

  getStats() {
    const duration = (Date.now() - this.stats.startTime) / 1000;
    return {
      ...this.stats,
      duration: `${duration.toFixed(1)}s`,
      successRate: `${((this.stats.emailsFound / this.stats.projectsProcessed) * 100).toFixed(1)}%`,
      averageTimePerProject: `${(duration / this.stats.projectsProcessed * 1000).toFixed(0)}ms`
    };
  }
}

module.exports = FusionEmailFinder;