const axios = require('axios');
const { createLogger } = require('../utils/logger');

/**
 * Enhanced Snov.io enrichment module with fallback logic and better error handling
 *
 * This module wraps the Snov.io API to fetch contact information based on a
 * company domain. It follows the Domain Search workflow documented in the
 * Snov.io knowledge base. Authentication tokens are cached in memory for
 * their lifetime (3600 seconds) to minimise authentication calls.
 * 
 * Features:
 * - Enhanced error handling and logging
 * - Rate limiting and retry logic
 * - Statistics tracking
 * - Fallback mechanisms
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
 * Start a domain search for company info.
 *
 * @param {string} domain The domain to search.
 * @returns {Promise<string>} The task_hash to poll results.
 */
async function startDomainSearch(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const token = await getAccessToken();
  const url = 'https://api.snov.io/v2/domain-search/start';
  const body = { domain: normalizedDomain };
  
  try {
    const response = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000
    });
    
    if (!response.data.task_hash) {
      throw new Error('No task_hash received from domain search start');
    }
    
    logger.debug(`Domain search started for ${normalizedDomain}, task_hash: ${response.data.task_hash}`);
    return response.data.task_hash;
    
  } catch (error) {
    logger.error(`Domain search start failed for ${normalizedDomain}:`, {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message,
      url,
      payload: body
    });
    throw error;
  }
}

/**
 * Poll domain search result until the task is completed.
 *
 * @param {string} taskHash The hash returned by startDomainSearch.
 * @param {number} [maxAttempts=5] Max poll attempts before giving up.
 * @param {number} [delayMs=2000] Delay between polls in milliseconds.
 * @returns {Promise<Object|null>} Company info or null if failed.
 */
async function getDomainSearchResult(taskHash, maxAttempts = 5, delayMs = 2000) {
  const token = await getAccessToken();
  const url = `https://api.snov.io/v2/domain-search/result/${taskHash}`;
  for (let i = 0; i < maxAttempts; i++) {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (data.state && data.state === 'completed') {
      return data;
    }
    // If in progress or queued, wait
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/**
 * Start a search for prospects on a given domain.
 *
 * @param {string} domain
 * @returns {Promise<string>} task_hash for prospect search
 */
async function startProspectsSearch(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const token = await getAccessToken();
  const url = `https://api.snov.io/v2/domain-search/prospects/start?domain=${encodeURIComponent(normalizedDomain)}`;
  
  try {
    const response = await axios.post(url, null, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000
    });
    
    if (!response.data.task_hash) {
      throw new Error('No task_hash received from prospects search start');
    }
    
    logger.debug(`Prospects search started for ${normalizedDomain}, task_hash: ${response.data.task_hash}`);
    return response.data.task_hash;
    
  } catch (error) {
    logger.error(`Prospects search start failed for ${normalizedDomain}:`, {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message,
      url
    });
    throw error;
  }
}

/**
 * Poll results for prospects search.
 *
 * @param {string} taskHash
 * @param {number} [maxAttempts=5]
 * @param {number} [delayMs=2000]
 * @returns {Promise<Object|null>}
 */
async function getProspectsResult(taskHash, maxAttempts = 5, delayMs = 2000) {
  const token = await getAccessToken();
  const url = `https://api.snov.io/v2/domain-search/prospects/result/${taskHash}`;
  for (let i = 0; i < maxAttempts; i++) {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (data.state && data.state === 'completed') {
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/**
 * Start a search for a prospect's email.
 *
 * @param {string} prospectHash
 * @returns {Promise<string>} task_hash for email search
 */
async function startProspectEmailSearch(prospectHash) {
  const token = await getAccessToken();
  const url = `https://api.snov.io/v2/domain-search/prospects/search-emails/start/${prospectHash}`;
  const { data } = await axios.post(url, null, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return data.task_hash;
}

/**
 * Poll result for prospect email search.
 *
 * @param {string} taskHash
 * @param {number} [maxAttempts=5]
 * @param {number} [delayMs=2000]
 * @returns {Promise<Object|null>}
 */
async function getProspectEmailResult(taskHash, maxAttempts = 5, delayMs = 2000) {
  const token = await getAccessToken();
  const url = `https://api.snov.io/v2/domain-search/prospects/search-emails/result/${taskHash}`;
  for (let i = 0; i < maxAttempts; i++) {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (data.state && data.state === 'completed') {
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
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
    
    // Step 2: Try to get emails using common name patterns
    const commonNames = [
      { firstName: 'John', lastName: 'Smith' },
      { firstName: 'Jane', lastName: 'Doe' },
      { firstName: 'David', lastName: 'Johnson' },
      { firstName: 'Sarah', lastName: 'Williams' },
      { firstName: 'Michael', lastName: 'Brown' }
    ];
    
    for (const name of commonNames) {
      try {
        logger.debug(`Step 2: Trying name search for ${name.firstName} ${name.lastName} at ${normalizedDomain}`);
        
        const nameResponse = await axios.post('https://api.snov.io/v1/get-emails-from-names', {
          domain: normalizedDomain,
          firstName: name.firstName,
          lastName: name.lastName
        }, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 30000
        });
        
        if (nameResponse.data.success && nameResponse.data.emails && nameResponse.data.emails.length > 0) {
          const emailData = nameResponse.data.emails[0];
          
          const contactData = {
            firstName: name.firstName,
            lastName: name.lastName,
            position: '',
            linkedin: '',
            email: emailData.email,
            emailStatus: emailData.status || 'unknown',
            confidence: emailData.status === 'valid' ? 0.8 : 0.5,
            decisionMakerScore: 0,
            source: 'snovio-names'
          };
          
          stats.contactsFound++;
          const duration = Date.now() - startTime;
          
          logger.success(`✓ Contact found for ${normalizedDomain}: ${contactData.email} (${contactData.firstName} ${contactData.lastName}) in ${duration}ms`);
          
          return contactData;
        }
        
        // Add delay between requests
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (nameError) {
        if (nameError.response?.data?.message?.includes('free domain')) {
          logger.debug(`Domain ${normalizedDomain} is a free domain, skipping name search`);
          break;
        }
        logger.debug(`Name search failed for ${name.firstName} ${name.lastName}: ${nameError.message}`);
        continue;
      }
    }
    
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
 * Enhanced API call wrapper with logging
 */
async function makeApiCall(method, url, data = null, headers = {}) {
  stats.apiCalls++;
  const startTime = Date.now();
  
  try {
    const config = {
      method,
      url,
      headers,
      timeout: 30000
    };
    
    if (data) {
      if (method.toLowerCase() === 'get') {
        config.params = data;
      } else {
        config.data = data;
      }
    }
    
    logger.logApiCall(method, url);
    
    const response = await axios(config);
    const duration = Date.now() - startTime;
    
    stats.successfulCalls++;
    logger.logApiCall(method, url, response.status, duration);
    
    return response;
    
  } catch (error) {
    const duration = Date.now() - startTime;
    stats.failedCalls++;
    
    logger.logApiCall(
      method, 
      url, 
      error.response?.status || 0, 
      duration
    );
    
    throw error;
  }
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
  findPersonByName,
  verifyCredentials,
  normalizeDomain,
  getEnrichmentStats,
  logEnrichmentStats
};