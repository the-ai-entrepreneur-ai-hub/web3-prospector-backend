const axios = require('axios');
const { createLogger } = require('../utils/logger');
const NameExtractor = require('../utils/name-extractor');
const FusionEmailFinder = require('../utils/fusion-email-finder');

/**
 * Enhanced Snov.io enrichment module using v1 API endpoints
 *
 * This module wraps the Snov.io v1 API to fetch contact information based on a
 * company domain. It uses the working v1 endpoints that are compatible with
 * the current API plan.
 */

// Cache for the access token and its expiration time
let accessToken = null;
let tokenExpiry = 0;

// Statistics tracking
const stats = {
  apiCalls: 0,
  successfulCalls: 0,
  failedCalls: 0,
  domainsProcessed: 0,
  contactsFound: 0,
  rateLimited: 0,
  startTime: Date.now()
};

// Logger instance
const logger = createLogger('SnovioEnrichment');

// Name extractor instance
let nameExtractor = null;
function getNameExtractor() {
  if (!nameExtractor) {
    nameExtractor = new NameExtractor();
  }
  return nameExtractor;
}

// Fusion email finder instance
let fusionFinder = null;
function getFusionFinder() {
  if (!fusionFinder) {
    fusionFinder = new FusionEmailFinder();
  }
  return fusionFinder;
}

/**
 * Normalize domain by removing protocol, www, paths, and converting to lowercase
 * @param {string} domain - Raw domain input
 * @returns {string} Normalized domain
 */
function normalizeDomain(domain) {
  if (!domain) return '';
  
  let normalized = domain.toLowerCase().trim();
  
  // Remove protocol
  normalized = normalized.replace(/^https?:\/\//, '');
  
  // Remove www prefix
  normalized = normalized.replace(/^www\./, '');
  
  // Remove path and query parameters
  normalized = normalized.split('/')[0].split('?')[0].split('#')[0];
  
  // Remove port if present
  normalized = normalized.split(':')[0];
  
  return normalized;
}

/**
 * Check if domain is a webmail provider that should be skipped
 * @param {string} domain 
 * @returns {boolean}
 */
function isWebmailDomain(domain) {
  const webmailDomains = [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
    'icloud.com', 'protonmail.com', 'mail.com', 'yandex.com', 'zoho.com'
  ];
  
  return webmailDomains.includes(domain.toLowerCase());
}

/**
 * Verify Snov.io API credentials by making a test call
 * @returns {Promise<boolean>} True if credentials are valid
 */
async function verifyCredentials() {
  try {
    const token = await getAccessToken();
    const response = await axios.get('https://api.snov.io/v1/get-balance', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    });
    
    logger.debug('Credentials verified successfully');
    logger.debug(`Account balance: ${response.data?.data?.balance} credits`);
    return response.status === 200 && response.data?.success === true;
  } catch (error) {
    logger.error('Credential verification failed:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Get a Snov.io access token using the client_credentials grant.
 *
 * @returns {Promise<string>} The access token.
 */
async function getAccessToken() {
  const now = Date.now();
  if (accessToken && tokenExpiry > now + 60 * 1000) {
    return accessToken;
  }
  const clientId = process.env.SNOVIO_CLIENT_ID;
  const clientSecret = process.env.SNOVIO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Snov.io API credentials are not configured.');
  }
  
  try {
    const url = 'https://api.snov.io/v1/oauth/access_token';
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    
    const response = await axios.post(url, params);
    const { data } = response;
    
    if (!data.access_token) {
      throw new Error('No access token received from Snov.io API');
    }
    
    accessToken = data.access_token;
    tokenExpiry = now + (data.expires_in || 3600) * 1000;
    
    logger.debug('Successfully obtained Snov.io access token');
    return accessToken;
    
  } catch (error) {
    logger.error('Failed to get Snov.io access token:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
}

/**
 * Search for people by name and company domain using v1 API
 * @param {string} firstName 
 * @param {string} lastName 
 * @param {string} domain 
 * @returns {Promise<Object|null>} Contact details or null if not found
 */
async function findPersonByName(firstName, lastName, domain) {
  const normalizedDomain = normalizeDomain(domain);
  const token = await getAccessToken();
  
  try {
    // Use the working v1 endpoint for name-based search
    const response = await axios.post('https://api.snov.io/v1/get-emails-from-names', {
      domain: normalizedDomain,
      firstName,
      lastName
    }, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000
    });
    
    if (response.data.success && response.data.emails && response.data.emails.length > 0) {
      const emailData = response.data.emails[0];
      
      logger.debug(`Found person by name: ${firstName} ${lastName} at ${normalizedDomain}`);
      return {
        firstName,
        lastName,
        email: emailData.email,
        position: '',
        linkedin: '',
        confidence: emailData.status === 'valid' ? 0.8 : 0.6,
        decisionMakerScore: 0,
        source: 'snovio-person-search'
      };
    }
    
    return null;
    
  } catch (error) {
    logger.debug(`Person search failed for ${firstName} ${lastName} at ${normalizedDomain}:`, {
      status: error.response?.status,
      data: error.response?.data
    });
    return null;
  }
}

/**
 * Enhanced domain enrichment using v1 API endpoints
 *
 * This uses the working v1 endpoints to find contacts for a domain.
 * It tries multiple approaches: domain email count, name-based search, etc.
 *
 * Fusion enrichment function that uses Public Data Fusion Engine
 * Combines GitHub, WHOIS, LinkedIn, and pattern analysis for maximum coverage
 */
async function enrichDomainWithFusion(domain, projectData = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const startTime = Date.now();
  stats.domainsProcessed++;
  
  logger.info(`🚀 Starting fusion enrichment for domain: ${normalizedDomain}`);
  
  try {
    // Skip webmail domains
    if (isWebmailDomain(normalizedDomain)) {
      logger.debug(`Skipping webmail domain: ${normalizedDomain}`);
      return null;
    }

    // Use Fusion Email Finder
    const fusionFinder = getFusionFinder();
    const fusionResult = await fusionFinder.findFounderEmail(
      projectData.name || normalizedDomain,
      normalizedDomain,
      projectData.github
    );

    if (fusionResult && fusionResult.primaryEmail) {
      logger.info(`✅ Fusion engine found primary email: ${fusionResult.primaryEmail}`);
      
      // Convert fusion result to contacts array format
      const contacts = [];
      
      // Add primary contact
      contacts.push({
        email: fusionResult.primaryEmail,
        firstName: 'Contact',
        lastName: '',
        name: projectData.name || 'Contact',
        position: 'Team Member',
        source: 'fusion-engine',
        confidence: fusionResult.confidence,
        decisionMakerScore: fusionResult.decisionMakerScore,
        extractedFrom: 'public-data-fusion'
      });

      // Add additional candidates as secondary contacts
      if (fusionResult.allCandidates && fusionResult.allCandidates.length > 1) {
        fusionResult.allCandidates.slice(1, 5).forEach((email, index) => {
          contacts.push({
            email: email,
            firstName: 'Contact',
            lastName: `${index + 2}`,
            name: `Contact ${index + 2}`,
            position: 'Team Member',
            source: 'fusion-secondary',
            confidence: fusionResult.confidence * 0.8,
            decisionMakerScore: fusionResult.decisionMakerScore - 1,
            extractedFrom: 'public-data-fusion'
          });
        });
      }

      stats.contactsFound += contacts.length;
      stats.successfulCalls++;
      
      const duration = Date.now() - startTime;
      logger.info(`✅ Fusion enrichment completed for ${normalizedDomain}: found ${contacts.length} contacts in ${duration}ms`);
      
      return contacts;
    } else {
      logger.warn(`No emails found for ${normalizedDomain} using fusion approach`);
      return null;
    }

  } catch (error) {
    stats.failedCalls++;
    const duration = Date.now() - startTime;
    
    logger.error(`Fusion enrichment failed for ${normalizedDomain}:`, {
      error: error.message,
      duration: `${duration}ms`
    });
    
    return null;
  }
}

/**
 * Enhanced enrichment function that uses real employee names for higher success rates
 * This is a two-pass approach: 1) Extract real names, 2) Use with Snov.io
 */
async function enrichDomainWithRealNames(domain, projectData = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const startTime = Date.now();
  stats.domainsProcessed++;
  
  logger.info(`Starting enhanced name-based enrichment for domain: ${normalizedDomain}`);
  
  try {
    const token = await getAccessToken();
    
    // Skip webmail domains
    if (isWebmailDomain(normalizedDomain)) {
      logger.debug(`Skipping webmail domain: ${normalizedDomain}`);
      return null;
    }

    // Step 1: Extract real employee names using multiple sources
    logger.info(`Step 1: Extracting real employee names for ${projectData.name || normalizedDomain}`);
    const extractor = getNameExtractor();
    const extractedNames = await extractor.extractNames({
      name: projectData.name || normalizedDomain,
      website: projectData.website || `https://${normalizedDomain}`,
      domain: normalizedDomain,
      github: projectData.github
    });

    if (!extractedNames || extractedNames.length === 0) {
      logger.warn(`No real names found for ${normalizedDomain}, falling back to standard method`);
      return await enrichDomain(normalizedDomain);
    }

    logger.info(`Found ${extractedNames.length} real names for ${normalizedDomain}`);

    // Step 2: Check domain has emails available
    const countResponse = await axios.post('https://api.snov.io/v1/get-domain-emails-count', {
      domain: normalizedDomain
    }, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000
    });
    
    if (!countResponse.data.success || countResponse.data.result === 0) {
      logger.info(`Domain ${normalizedDomain} has no emails available in Snov.io database`);
      return null;
    }

    logger.info(`Domain ${normalizedDomain} has ${countResponse.data.result} potential emails, trying with real names`);

    // Step 3: Use real names to find email addresses
    const contacts = [];
    
    for (const nameData of extractedNames.slice(0, 10)) { // Limit to 10 names to avoid API overuse
      try {
        const names = nameData.name.split(' ');
        if (names.length >= 2) {
          const firstName = names[0];
          const lastName = names[names.length - 1]; // Handle middle names

          logger.debug(`Trying Snov.io with real name: ${firstName} ${lastName}`);
          
          const result = await findPersonByName(firstName, lastName, normalizedDomain);
          if (result) {
            contacts.push({
              ...result,
              originalRole: nameData.role,
              source: `${nameData.source}->snovio`,
              decisionMakerScore: nameData.decisionMakerScore,
              extractedFrom: nameData.url || nameData.source
            });
            
            logger.info(`✅ Found email for ${firstName} ${lastName} at ${normalizedDomain}`);
          } else {
            logger.debug(`No email found for ${firstName} ${lastName} at ${normalizedDomain}`);
          }
          
          // Rate limiting between name searches
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        logger.debug(`Error searching for ${nameData.name}: ${error.message}`);
        continue;
      }
    }

    // Step 4: Sort contacts by decision maker score and return
    if (contacts.length > 0) {
      contacts.sort((a, b) => b.decisionMakerScore - a.decisionMakerScore);
      
      stats.contactsFound += contacts.length;
      stats.successfulCalls++;
      
      const duration = Date.now() - startTime;
      logger.info(`✅ Enhanced enrichment completed for ${normalizedDomain}: found ${contacts.length} contacts in ${duration}ms`);
      
      return contacts;
    } else {
      logger.warn(`No emails found for ${normalizedDomain} despite having ${extractedNames.length} real names`);
      return null;
    }

  } catch (error) {
    stats.failedCalls++;
    const duration = Date.now() - startTime;
    
    logger.error(`Enhanced enrichment failed for ${normalizedDomain}:`, {
      error: error.message,
      duration: `${duration}ms`,
      stack: error.stack
    });
    
    return null;
  }
}

/**
 * Original enrichment function (fallback method)
 * @param {string} domain
 * @returns {Promise<Object|null>} Contact details or null if not found.
 */
async function enrichDomain(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const startTime = Date.now();
  stats.domainsProcessed++;
  
  logger.info(`Starting enrichment for domain: ${normalizedDomain}`);
  
  try {
    const token = await getAccessToken();
    
    // Skip webmail and free domains that won't work
    if (isWebmailDomain(normalizedDomain)) {
      logger.debug(`Skipping webmail domain: ${normalizedDomain}`);
      return null;
    }
    
    // Step 1: Check domain email count first
    logger.debug(`Step 1: Checking domain email count for ${normalizedDomain}`);
    const countResponse = await axios.post('https://api.snov.io/v1/get-domain-emails-count', {
      domain: normalizedDomain
    }, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000
    });
    
    if (!countResponse.data.success || countResponse.data.result === 0) {
      if (countResponse.data.webmail) {
        logger.debug(`Domain ${normalizedDomain} is webmail, skipping`);
        return null;
      }
      
      logger.debug(`No emails found in domain count for ${normalizedDomain}`);
      return await tryPersonSearchFallback(normalizedDomain);
    }
    
    logger.debug(`Found ${countResponse.data.result} potential emails for ${normalizedDomain}`);
    
    // Step 2: Log that domain has potential but needs real names
    // Since generic names don't work, we need real employee names from other sources
    const emailCount = countResponse.data.result;
    logger.info(`Found ${emailCount} potential emails for ${normalizedDomain}, but requires real employee names for extraction`);
    
    // Note: Snov.io works best when we have real names from LinkedIn/website scraping
    // The generic name approach doesn't work for most domains
    logger.debug(`Domain ${normalizedDomain} has ${emailCount} emails but name-based search needs actual employee names`);
    
    logger.warn(`No valid contacts found for ${normalizedDomain} using available methods`);
    return null;
    
  } catch (err) {
    stats.failedCalls++;
    const duration = Date.now() - startTime;
    
    // Enhanced error logging
    if (err.response) {
      const { status, statusText, data } = err.response;
      logger.error(`Snov.io API error for ${normalizedDomain}:`, {
        status,
        statusText,
        errorData: data,
        domain: normalizedDomain,
        duration: `${duration}ms`,
        endpoint: err.config?.url,
        method: err.config?.method
      });
      
      if (data && data.message) {
        logger.warn(`API message: ${data.message}`);
      }
    }
    
    // Check for rate limiting with exponential backoff
    if (err.response && err.response.status === 429) {
      stats.rateLimited++;
      const retryAfter = err.response.headers['retry-after'] || 5;
      const delay = Math.min(retryAfter * 1000, 30000);
      
      logger.warn(`Rate limited for domain ${normalizedDomain} - waiting ${delay/1000}s before retry`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      try {
        return await enrichDomain(normalizedDomain);
      } catch (retryErr) {
        logger.error(`Retry failed for domain ${normalizedDomain}:`, retryErr);
        return null;
      }
    }
    
    // Check for auth errors and refresh token
    if (err.response && err.response.status === 401) {
      logger.warn(`Auth error for ${normalizedDomain}, refreshing token...`);
      accessToken = null;
      tokenExpiry = 0;
      
      try {
        return await enrichDomain(normalizedDomain);
      } catch (retryErr) {
        logger.error(`Token refresh retry failed for domain ${normalizedDomain}:`, retryErr);
        return null;
      }
    }
    
    logger.error(`Snov.io enrichment error for domain ${normalizedDomain} (${duration}ms):`, err.message);
    return null;
  }
}

/**
 * Try person search fallback for common executive names
 * @param {string} domain 
 * @returns {Promise<Object|null>}
 */
async function tryPersonSearchFallback(domain) {
  const commonExecutiveNames = [
    { firstName: 'John', lastName: 'Smith' },
    { firstName: 'Jane', lastName: 'Johnson' },
    { firstName: 'David', lastName: 'Williams' },
    { firstName: 'Sarah', lastName: 'Brown' },
    { firstName: 'Michael', lastName: 'Davis' }
  ];
  
  logger.debug(`Trying person search fallback for ${domain}`);
  
  for (const name of commonExecutiveNames) {
    try {
      const result = await findPersonByName(name.firstName, name.lastName, domain);
      if (result) {
        return result;
      }
      
      // Add delay between attempts
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      logger.debug(`Person search fallback failed for ${name.firstName} ${name.lastName}`);
    }
  }
  
  return null;
}

/**
 * Calculate decision maker score based on job title
 * @param {string} position 
 * @returns {number} Score from 0-10, higher = more likely decision maker
 */
function getDecisionMakerScore(position) {
  if (!position) return 0;
  
  const title = position.toLowerCase();
  
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
 * Get enrichment statistics
 */
function getEnrichmentStats() {
  const runtime = Date.now() - stats.startTime;
  
  return {
    ...stats,
    runtime: runtime,
    successRate: stats.apiCalls > 0 ? (stats.successfulCalls / stats.apiCalls * 100).toFixed(1) : '0.0',
    averageTime: stats.domainsProcessed > 0 ? Math.round(runtime / stats.domainsProcessed) : 0,
    contactsRate: stats.domainsProcessed > 0 ? (stats.contactsFound / stats.domainsProcessed * 100).toFixed(1) : '0.0'
  };
}

/**
 * Basic email validation (format check only)
 * Since Snov.io email verification API seems unavailable, use basic format validation
 * @param {string} email - Email address to verify
 * @returns {Promise<Object|null>} Verification result or null if failed
 */
async function verifyEmail(email) {
  if (!email || typeof email !== 'string') {
    return null;
  }

  // Basic email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const isValidFormat = emailRegex.test(email);
  
  // Check for disposable/temporary email domains
  const disposableDomains = [
    '10minutemail.com', 'tempmail.org', 'guerrillamail.com', 'mailinator.com',
    'temp-mail.org', 'throwaway.email', 'yopmail.com', '20minutemail.com'
  ];
  
  const domain = email.split('@')[1]?.toLowerCase();
  const isDisposable = disposableDomains.includes(domain);
  
  // Check for common webmail providers
  const webmailDomains = [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
    'icloud.com', 'protonmail.com', 'mail.com'
  ];
  const isWebmail = webmailDomains.includes(domain);

  logger.debug(`Basic email validation for ${email}: format=${isValidFormat}, disposable=${isDisposable}, webmail=${isWebmail}`);

  // Note: Snov.io email verification API appears unavailable on current plan
  // Using basic format validation as fallback
  stats.successfulCalls++;
  return {
    email: email,
    status: isValidFormat ? 'valid' : 'invalid',
    result: isValidFormat && !isDisposable ? 'deliverable' : 'risky',
    isValid: isValidFormat && !isDisposable,
    is_valid_format: isValidFormat,
    is_disposable: isDisposable,
    is_webmail: isWebmail,
    verification_method: 'basic_format_check'
  };
}

/**
 * Verify multiple emails in batch
 * @param {Array<string>} emails - Array of email addresses to verify
 * @returns {Promise<Array>} Array of verification results
 */
async function verifyEmails(emails) {
  if (!Array.isArray(emails) || emails.length === 0) {
    return [];
  }

  // Filter out invalid emails
  const validEmails = emails.filter(email => email && typeof email === 'string' && email.includes('@'));
  
  if (validEmails.length === 0) {
    return [];
  }

  // Snov.io supports up to 100 emails per batch
  const batchSize = 100;
  const results = [];

  for (let i = 0; i < validEmails.length; i += batchSize) {
    const batch = validEmails.slice(i, i + batchSize);
    
    try {
      const token = await getAccessToken();
      stats.apiCalls++;

      const response = await axios.post('https://api.snov.io/v1/get-emails-verification', {
        emails: batch
      }, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000
      });

      if (response.data.success && response.data.emails) {
        stats.successfulCalls++;
        
        const batchResults = response.data.emails.map(verification => ({
          email: verification.email,
          status: verification.status,
          result: verification.result,
          isValid: (verification.status === 'valid' && verification.result === 'deliverable') || 
                 (verification.status === 'catch_all') ||
                 (verification.status === 'valid' && verification.result === 'risky')
        }));

        results.push(...batchResults);
        
        logger.debug(`Verified batch of ${batch.length} emails`);
      } else {
        stats.failedCalls++;
        logger.warn(`Batch verification failed for ${batch.length} emails`);
      }

      // Add delay between batches to respect rate limits
      if (i + batchSize < validEmails.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

    } catch (error) {
      stats.failedCalls++;
      logger.error(`Batch email verification failed:`, error.message);
      
      // Handle rate limiting
      if (error.response && error.response.status === 429) {
        stats.rateLimited++;
        const retryAfter = error.response.headers['retry-after'] || 10;
        const delay = Math.min(retryAfter * 1000, 60000);
        
        logger.warn(`Rate limited during batch verification - waiting ${delay/1000}s`);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Retry the failed batch
        i -= batchSize;
      }
    }
  }

  return results;
}

/**
 * Log current enrichment statistics
 */
function logEnrichmentStats() {
  const enrichmentStats = getEnrichmentStats();
  
  logger.info('=== SNOVIO ENRICHMENT STATISTICS ===');
  logger.info(`Runtime: ${(enrichmentStats.runtime / 1000).toFixed(1)}s`);
  logger.info(`Domains Processed: ${enrichmentStats.domainsProcessed}`);
  logger.info(`Contacts Found: ${enrichmentStats.contactsFound} (${enrichmentStats.contactsRate}%)`);
  logger.info(`API Calls: ${enrichmentStats.apiCalls} (${enrichmentStats.successRate}% success)`);
  logger.info(`Rate Limited: ${enrichmentStats.rateLimited} times`);
  logger.info(`Average Time per Domain: ${enrichmentStats.averageTime}ms`);
}

module.exports = {
  getAccessToken,
  enrichDomain,
  enrichDomainWithRealNames,
  enrichDomainWithFusion,
  findPersonByName,
  verifyCredentials,
  verifyEmail,
  verifyEmails,
  normalizeDomain,
  getEnrichmentStats,
  logEnrichmentStats
};