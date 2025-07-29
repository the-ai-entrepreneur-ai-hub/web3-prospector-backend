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
  const url = 'https://api.snov.io/v1/oauth/access_token';
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  const { data } = await axios.post(url, params);
  accessToken = data.access_token;
  tokenExpiry = now + data.expires_in * 1000;
  return accessToken;
}

/**
 * Start a domain search for company info.
 *
 * @param {string} domain The domain to search.
 * @returns {Promise<string>} The task_hash to poll results.
 */
async function startDomainSearch(domain) {
  const token = await getAccessToken();
  const url = 'https://api.snov.io/v2/domain-search/start';
  const body = { domain };
  const { data } = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return data.task_hash;
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
  const token = await getAccessToken();
  const url = `https://api.snov.io/v2/domain-search/prospects/start?domain=${encodeURIComponent(domain)}`;
  const { data } = await axios.post(url, null, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return data.task_hash;
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
 * Enhanced domain enrichment with fallback logic and better error handling.
 *
 * This helper wraps the multi‑step Domain Search workflow into a single call.
 * It returns the first available prospect with a verified email, along with
 * other relevant contact fields (LinkedIn, position, etc.). If no contact is
 * found, it returns null.
 *
 * @param {string} domain
 * @returns {Promise<Object|null>} Contact details or null if not found.
 */
async function enrichDomain(domain) {
  const startTime = Date.now();
  stats.domainsProcessed++;
  
  logger.info(`Starting enrichment for domain: ${domain}`);
  
  try {
    // Step 1: Start domain search and get company info
    logger.debug(`Step 1: Starting domain search for ${domain}`);
    const domainTask = await startDomainSearch(domain);
    const domainResult = await getDomainSearchResult(domainTask);
    
    if (!domainResult) {
      logger.warn(`Domain search failed for ${domain}: no company data found`);
      return null;
    }
    
    logger.debug(`Domain search completed for ${domain}: found company info`);
    
    // Step 2: Start prospects search
    logger.debug(`Step 2: Starting prospects search for ${domain}`);
    const prospectsTask = await startProspectsSearch(domain);
    const prospectsResult = await getProspectsResult(prospectsTask);
    
    if (!prospectsResult || !Array.isArray(prospectsResult.prospects)) {
      logger.warn(`Prospects search failed for ${domain}: no prospects found`);
      return null;
    }
    
    logger.debug(`Found ${prospectsResult.prospects.length} prospects for ${domain}`);
    
    // Try multiple prospects if the first one fails
    const maxProspects = Math.min(prospectsResult.prospects.length, 3);
    
    for (let i = 0; i < maxProspects; i++) {
      const prospect = prospectsResult.prospects[i];
      
      if (!prospect || !prospect.search_emails_start) {
        logger.debug(`Skipping prospect ${i + 1}: no email search capability`);
        continue;
      }
      
      try {
        logger.debug(`Step 3: Searching emails for prospect ${i + 1}: ${prospect.first_name} ${prospect.last_name}`);
        
        // Step 3: Start email search for the chosen prospect
        const emailTask = await startProspectEmailSearch(prospect.prospect_hash);
        const emailResult = await getProspectEmailResult(emailTask);
        
        if (!emailResult || !Array.isArray(emailResult.emails) || emailResult.emails.length === 0) {
          logger.debug(`No emails found for prospect ${i + 1}`);
          continue;
        }
        
        // Choose the first valid email, or fallback to any email
        const validEmail = emailResult.emails.find((e) => e.status === 'valid');
        const emailData = validEmail || emailResult.emails[0];
        
        if (!emailData || !emailData.email) {
          logger.debug(`No usable email found for prospect ${i + 1}`);
          continue;
        }
        
        const contactData = {
          firstName: prospect.first_name,
          lastName: prospect.last_name,
          position: prospect.position,
          linkedin: prospect.linkedin || '',
          email: emailData.email,
          emailStatus: emailData.status || 'unknown',
          confidence: validEmail ? 0.9 : 0.6,
          source: 'snovio'
        };
        
        stats.contactsFound++;
        const duration = Date.now() - startTime;
        
        logger.success(`✓ Contact found for ${domain}: ${contactData.email} (${contactData.firstName} ${contactData.lastName}) in ${duration}ms`);
        
        return contactData;
        
      } catch (prospectError) {
        logger.debug(`Error processing prospect ${i + 1} for ${domain}: ${prospectError.message}`);
        continue;
      }
    }
    
    logger.warn(`No valid contacts found for ${domain} after checking ${maxProspects} prospects`);
    return null;
    
  } catch (err) {
    stats.failedCalls++;
    const duration = Date.now() - startTime;
    
    // Check for rate limiting
    if (err.response && err.response.status === 429) {
      stats.rateLimited++;
      logger.warn(`Rate limited for domain ${domain} - waiting before retry`);
      
      // Wait and retry once
      await new Promise(resolve => setTimeout(resolve, 5000));
      try {
        return await enrichDomain(domain);
      } catch (retryErr) {
        logger.error(`Retry failed for domain ${domain}:`, retryErr);
        return null;
      }
    }
    
    logger.error(`Snov.io enrichment error for domain ${domain} (${duration}ms):`, err);
    return null;
  }
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
  getEnrichmentStats,
  logEnrichmentStats
};