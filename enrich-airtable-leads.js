#!/usr/bin/env node

/**
 * Enrich Airtable leads with OSINT email discovery
 * 
 * This script connects to your Airtable, finds leads without contact information,
 * enriches them using the OSINT module, and updates the records.
 */

require('dotenv').config();
const Airtable = require('airtable');
const { createLogger } = require('./src/utils/logger');

// Try to use the full OSINT module first, fallback to Snov.io only
let discoverProjectEmails;
try {
  discoverProjectEmails = require('./src/osint/emailDiscovery-windows').discoverProjectEmails;
  console.log('Using full OSINT module (with browser automation)');
} catch (error) {
  console.log('Browser automation not available, using Snov.io API only');
  // Fallback to Snov.io only enrichment
  const { enrichDomain } = require('./src/enrichment/snovio');
  
  discoverProjectEmails = async (project) => {
    const domain = new URL(project.website).hostname.replace(/^www\./, '');
    
    try {
      const snovioResult = await enrichDomain(domain);
      
      if (snovioResult && snovioResult.email) {
        return {
          project: project.name,
          primary_email: snovioResult.email,
          alternate_emails: [],
          evidence: {
            snovio: `${snovioResult.firstName} ${snovioResult.lastName} (${snovioResult.position})`,
            website: '',
            twitter: '',
            telegram: ''
          },
          verification_status: snovioResult.emailStatus === 'valid' ? 'valid' : 'unverifiable'
        };
      }
    } catch (error) {
      console.log(`Snov.io enrichment failed for ${domain}: ${error.message}`);
    }
    
    return {
      project: project.name,
      primary_email: '',
      alternate_emails: [],
      evidence: { snovio: '', website: '', twitter: '', telegram: '' },
      verification_status: 'unverifiable'
    };
  };
}

const logger = createLogger('AirtableEnrichment');

// Statistics tracking
const stats = {
  totalLeads: 0,
  leadsWithContacts: 0,
  leadsToEnrich: 0,
  enrichedLeads: 0,
  failedEnrichments: 0,
  contactsFound: 0,
  updatedRecords: 0,
  startTime: Date.now()
};

/**
 * Initialize Airtable connection
 */
function initializeAirtable() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME;

  if (!apiKey || !baseId || !tableName) {
    throw new Error('Airtable configuration missing. Check AIRTABLE_API_KEY, AIRTABLE_BASE_ID, and AIRTABLE_TABLE_NAME in .env file.');
  }

  const base = new Airtable({ apiKey }).base(baseId);
  return base(tableName);
}

/**
 * Check if a lead has contact information
 */
function hasContacts(record) {
  const fields = record.fields;
  return !!(
    fields.email || 
    fields.Email || 
    fields.primary_email ||
    fields['Primary Email'] ||
    fields.contact_email ||
    fields['Contact Email'] ||
    fields.contacts ||
    fields.Contacts
  );
}

/**
 * Extract social handles from URLs
 */
function extractSocialHandles(record) {
  const fields = record.fields;
  
  // Extract Twitter handle
  let twitterHandle = '';
  const twitterField = fields.twitter || fields.Twitter || fields.x || fields.X || '';
  if (twitterField) {
    const twitterMatch = twitterField.match(/(?:twitter\.com|x\.com)\/([^\/\?]+)/i);
    if (twitterMatch && twitterMatch[1]) {
      twitterHandle = twitterMatch[1];
    }
  }
  
  // Extract Telegram handle
  let telegramHandle = '';
  const telegramField = fields.telegram || fields.Telegram || '';
  if (telegramField) {
    const telegramMatch = telegramField.match(/t\.me\/([^\/\?]+)/i);
    if (telegramMatch && telegramMatch[1]) {
      telegramHandle = telegramMatch[1];
    }
  }
  
  return { twitterHandle, telegramHandle };
}

/**
 * Prepare project data for OSINT enrichment
 */
function prepareProjectData(record) {
  const fields = record.fields;
  const { twitterHandle, telegramHandle } = extractSocialHandles(record);
  
  return {
    name: fields.name || fields.Name || fields.project_name || 'Unknown Project',
    website: fields.website || fields.Website || fields.url || fields.URL || '',
    twitter: twitterHandle,
    telegram: telegramHandle
  };
}

/**
 * Update Airtable record with enriched data
 */
async function updateAirtableRecord(table, recordId, osintResult) {
  const updateFields = {};
  
  // Add primary email
  if (osintResult.primary_email) {
    updateFields['Primary Email'] = osintResult.primary_email;
    updateFields['Email'] = osintResult.primary_email; // For compatibility
  }
  
  // Add alternate emails
  if (osintResult.alternate_emails && osintResult.alternate_emails.length > 0) {
    updateFields['Alternate Emails'] = osintResult.alternate_emails.join(', ');
  }
  
  // Add evidence
  const evidenceText = Object.entries(osintResult.evidence)
    .filter(([key, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  
  if (evidenceText) {
    updateFields['Contact Evidence'] = evidenceText;
  }
  
  // Add verification status
  updateFields['Email Verification'] = osintResult.verification_status;
  
  // Add enrichment metadata
  updateFields['Enriched Date'] = new Date().toISOString().split('T')[0];
  updateFields['Enriched By'] = 'osint-email-discovery';
  
  try {
    await table.update(recordId, updateFields);
    stats.updatedRecords++;
    return true;
  } catch (error) {
    logger.error(`Failed to update record ${recordId}:`, error.message);
    return false;
  }
}

/**
 * Fetch all leads from Airtable
 */
async function fetchAllLeads(table) {
  const records = [];
  
  await table.select({
    // You can add filters here if needed
    // filterByFormula: "NOT({Email})", // Only records without email
  }).eachPage((pageRecords, fetchNextPage) => {
    records.push(...pageRecords);
    fetchNextPage();
  });
  
  return records;
}

/**
 * Enrich a single lead
 */
async function enrichLead(table, record, index, total) {
  const projectData = prepareProjectData(record);
  
  logger.info(`[${index + 1}/${total}] Enriching: ${projectData.name}`);
  
  try {
    const osintResult = await discoverProjectEmails(projectData);
    
    if (osintResult.primary_email) {
      const updated = await updateAirtableRecord(table, record.id, osintResult);
      
      if (updated) {
        stats.enrichedLeads++;
        stats.contactsFound++;
        logger.success(`✓ Found and updated: ${projectData.name} -> ${osintResult.primary_email}`);
      }
    } else {
      stats.failedEnrichments++;
      logger.warn(`✗ No contacts found for: ${projectData.name}`);
    }
    
  } catch (error) {
    stats.failedEnrichments++;
    logger.error(`✗ Enrichment failed for ${projectData.name}:`, error.message);
  }
}

/**
 * Display final statistics
 */
function displayStats() {
  const duration = Date.now() - stats.startTime;
  const successRate = stats.leadsToEnrich > 0 ? (stats.enrichedLeads / stats.leadsToEnrich * 100).toFixed(1) : '0.0';
  
  logger.info('=== AIRTABLE ENRICHMENT RESULTS ===');
  logger.info(`Total Runtime: ${(duration / 1000).toFixed(1)}s`);
  logger.info(`Total Leads in Airtable: ${stats.totalLeads}`);
  logger.info(`Leads Already Had Contacts: ${stats.leadsWithContacts}`);
  logger.info(`Leads Requiring Enrichment: ${stats.leadsToEnrich}`);
  logger.info(`Leads Successfully Enriched: ${stats.enrichedLeads}`);
  logger.info(`Airtable Records Updated: ${stats.updatedRecords}`);
  logger.info(`Failed Enrichments: ${stats.failedEnrichments}`);
  logger.info(`Contact Discovery Rate: ${successRate}%`);
  logger.info(`Total Contacts Found: ${stats.contactsFound}`);
  logger.info(`Average Time per Lead: ${stats.leadsToEnrich > 0 ? (duration / stats.leadsToEnrich / 1000).toFixed(1) : 0}s`);
}

/**
 * Main enrichment process
 */
async function enrichAirtableLeads() {
  logger.info('=== Airtable OSINT Email Enrichment Started ===');
  
  try {
    // Initialize Airtable connection
    const table = initializeAirtable();
    logger.info('✓ Connected to Airtable');
    
    // Fetch all leads
    logger.info('Fetching leads from Airtable...');
    const allRecords = await fetchAllLeads(table);
    stats.totalLeads = allRecords.length;
    
    if (allRecords.length === 0) {
      logger.error('No records found in Airtable. Check your base ID and table name.');
      return;
    }
    
    logger.info(`Found ${allRecords.length} records in Airtable`);
    
    // Filter leads that need enrichment
    const leadsWithContacts = allRecords.filter(hasContacts);
    const leadsToEnrich = allRecords.filter(record => !hasContacts(record));
    
    stats.leadsWithContacts = leadsWithContacts.length;
    stats.leadsToEnrich = leadsToEnrich.length;
    
    logger.info(`${stats.leadsWithContacts} leads already have contact information`);
    logger.info(`${stats.leadsToEnrich} leads need enrichment`);
    
    if (stats.leadsToEnrich === 0) {
      logger.info('All leads already have contact information. Nothing to enrich.');
      return;
    }
    
    // Process leads with OSINT enrichment
    logger.info(`Starting OSINT enrichment for ${leadsToEnrich.length} leads...`);
    
    for (let i = 0; i < leadsToEnrich.length; i++) {
      const record = leadsToEnrich[i];
      await enrichLead(table, record, i, leadsToEnrich.length);
      
      // Add delay between requests to avoid rate limiting
      if (i < leadsToEnrich.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // Display final statistics
    displayStats();
    
    logger.success('✓ Airtable enrichment completed successfully!');
    
  } catch (error) {
    logger.error('Airtable enrichment failed:', error);
    throw error;
  }
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    limit: null,
    dryRun: false
  };
  
  args.forEach(arg => {
    if (arg.startsWith('--limit=')) {
      config.limit = parseInt(arg.split('=')[1]);
    } else if (arg === '--dry-run') {
      config.dryRun = true;
    }
  });
  
  return config;
}

// Run the enrichment process
if (require.main === module) {
  const config = parseArgs();
  
  if (config.dryRun) {
    logger.info('DRY RUN mode - would enrich Airtable leads but not actually update records');
    return;
  }
  
  enrichAirtableLeads().catch(error => {
    logger.error('Enrichment process failed:', error);
    process.exit(1);
  });
}

module.exports = {
  enrichAirtableLeads,
  prepareProjectData,
  hasContacts
};