#!/usr/bin/env node

/**
 * OSINT Email Enrichment for Existing Leads
 * 
 * This script enriches existing leads that don't have contact information
 * using the new OSINT email discovery module. It processes leads from
 * CoinMarketCap and ICODrops output files and adds contact information.
 * 
 * Usage:
 *   node enrich-existing-leads.js [--dry-run] [--limit=10] [--source=CoinMarketCap,ICODrops]
 */

const fs = require('fs');
const path = require('path');
const { discoverProjectEmails } = require('./src/osint/emailDiscovery');
const { createLogger } = require('./src/utils/logger');

const logger = createLogger('LeadEnrichment');

// Configuration
const OUTPUT_DIR = './output';
const ENRICHED_DIR = './output/enriched';
const BACKUP_DIR = './output/backup';

// Statistics tracking
const stats = {
  totalLeads: 0,
  leadsWithContacts: 0,
  leadsToEnrich: 0,
  enrichedLeads: 0,
  failedEnrichments: 0,
  contactsFound: 0,
  startTime: Date.now()
};

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    dryRun: false,
    limit: null,
    sources: ['CoinMarketCap', 'ICODrops'],
    verbose: false
  };
  
  args.forEach(arg => {
    if (arg === '--dry-run') {
      config.dryRun = true;
    } else if (arg.startsWith('--limit=')) {
      config.limit = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--source=')) {
      config.sources = arg.split('=')[1].split(',');
    } else if (arg === '--verbose') {
      config.verbose = true;
    }
  });
  
  return config;
}

/**
 * Load leads from JSON files
 */
function loadLeads(sources) {
  const allLeads = [];
  
  sources.forEach(source => {
    const filePath = path.join(OUTPUT_DIR, `${source}.json`);
    
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const leads = JSON.parse(content);
        
        if (Array.isArray(leads)) {
          leads.forEach(lead => {
            lead._originalSource = source;
            allLeads.push(lead);
          });
          
          logger.info(`Loaded ${leads.length} leads from ${source}.json`);
        }
      } catch (error) {
        logger.error(`Failed to load ${source}.json:`, error.message);
      }
    } else {
      logger.warn(`File not found: ${filePath}`);
    }
  });
  
  return allLeads;
}

/**
 * Check if a lead has contact information
 */
function hasContacts(lead) {
  return !!(
    lead.email || 
    lead.emails || 
    lead.contacts || 
    lead.contact_email ||
    lead.primary_email
  );
}

/**
 * Prepare project data for OSINT module
 */
function prepareProjectData(lead) {
  // Extract Twitter handle from URL
  let twitterHandle = '';
  if (lead.twitter) {
    const twitterMatch = lead.twitter.match(/(?:twitter\.com|x\.com)\/([^\/\?]+)/i);
    if (twitterMatch && twitterMatch[1]) {
      twitterHandle = twitterMatch[1];
    }
  }
  
  // Extract Telegram handle from URL
  let telegramHandle = '';
  if (lead.telegram) {
    const telegramMatch = lead.telegram.match(/t\.me\/([^\/\?]+)/i);
    if (telegramMatch && telegramMatch[1]) {
      telegramHandle = telegramMatch[1];
    }
  }
  
  return {
    name: lead.name,
    website: lead.website,
    twitter: twitterHandle,
    telegram: telegramHandle
  };
}

/**
 * Merge OSINT results back into lead object
 */
function mergeOsintResults(lead, osintResult) {
  const enrichedLead = { ...lead };
  
  // Add primary email
  if (osintResult.primary_email) {
    enrichedLead.primary_email = osintResult.primary_email;
    enrichedLead.email = osintResult.primary_email; // For compatibility
  }
  
  // Add alternate emails
  if (osintResult.alternate_emails && osintResult.alternate_emails.length > 0) {
    enrichedLead.alternate_emails = osintResult.alternate_emails;
  }
  
  // Add evidence sources
  enrichedLead.osint_evidence = osintResult.evidence;
  
  // Add verification status
  enrichedLead.email_verification = osintResult.verification_status;
  
  // Add enrichment metadata
  enrichedLead.enriched_date = new Date().toISOString().split('T')[0];
  enrichedLead.enriched_by = 'osint-email-discovery';
  
  return enrichedLead;
}

/**
 * Enrich a single lead with OSINT data
 */
async function enrichLead(lead, index, total) {
  const projectData = prepareProjectData(lead);
  
  logger.info(`[${index + 1}/${total}] Enriching: ${lead.name} (${lead.domain})`);
  
  try {
    const osintResult = await discoverProjectEmails(projectData);
    
    if (osintResult.primary_email) {
      const enrichedLead = mergeOsintResults(lead, osintResult);
      stats.enrichedLeads++;
      stats.contactsFound++;
      
      logger.success(`✓ Found email for ${lead.name}: ${osintResult.primary_email}`);
      if (osintResult.alternate_emails.length > 0) {
        logger.info(`  + ${osintResult.alternate_emails.length} alternate emails`);
      }
      
      return enrichedLead;
    } else {
      stats.failedEnrichments++;
      logger.warn(`✗ No contacts found for ${lead.name}`);
      return lead; // Return original lead unchanged
    }
    
  } catch (error) {
    stats.failedEnrichments++;
    logger.error(`✗ Enrichment failed for ${lead.name}:`, error.message);
    return lead; // Return original lead unchanged
  }
}

/**
 * Create backup and output directories
 */
function createDirectories() {
  [ENRICHED_DIR, BACKUP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(`Created directory: ${dir}`);
    }
  });
}

/**
 * Save enriched leads grouped by source
 */
function saveEnrichedLeads(enrichedLeads, dryRun = false) {
  if (dryRun) {
    logger.info('DRY RUN: Would save enriched leads to files');
    return;
  }
  
  // Group leads by original source
  const groupedLeads = {};
  enrichedLeads.forEach(lead => {
    const source = lead._originalSource || 'Unknown';
    if (!groupedLeads[source]) {
      groupedLeads[source] = [];
    }
    // Remove the _originalSource property before saving
    const { _originalSource, ...leadData } = lead;
    groupedLeads[source].push(leadData);
  });
  
  // Save each group to a separate file
  Object.entries(groupedLeads).forEach(([source, leads]) => {
    const filename = `${source}_enriched.json`;
    const filepath = path.join(ENRICHED_DIR, filename);
    
    fs.writeFileSync(filepath, JSON.stringify(leads, null, 2));
    logger.success(`Saved ${leads.length} enriched leads to ${filepath}`);
  });
  
  // Save combined file
  const allEnriched = enrichedLeads.map(({ _originalSource, ...lead }) => lead);
  const combinedPath = path.join(ENRICHED_DIR, 'all_enriched.json');
  fs.writeFileSync(combinedPath, JSON.stringify(allEnriched, null, 2));
  logger.success(`Saved ${allEnriched.length} total enriched leads to ${combinedPath}`);
}

/**
 * Create backup of original files
 */
function createBackup(sources, dryRun = false) {
  if (dryRun) {
    logger.info('DRY RUN: Would create backup of original files');
    return;
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
  const backupPath = path.join(BACKUP_DIR, `pre_enrichment_${timestamp}`);
  
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath, { recursive: true });
  }
  
  sources.forEach(source => {
    const sourceFile = path.join(OUTPUT_DIR, `${source}.json`);
    const backupFile = path.join(backupPath, `${source}.json`);
    
    if (fs.existsSync(sourceFile)) {
      fs.copyFileSync(sourceFile, backupFile);
      logger.info(`Backed up ${sourceFile} to ${backupFile}`);
    }
  });
}

/**
 * Display final statistics
 */
function displayStats() {
  const duration = Date.now() - stats.startTime;
  const successRate = stats.leadsToEnrich > 0 ? (stats.enrichedLeads / stats.leadsToEnrich * 100).toFixed(1) : '0.0';
  
  logger.info('=== OSINT ENRICHMENT RESULTS ===');
  logger.info(`Total Runtime: ${(duration / 1000).toFixed(1)}s`);
  logger.info(`Total Leads Processed: ${stats.totalLeads}`);
  logger.info(`Leads Already Had Contacts: ${stats.leadsWithContacts}`);
  logger.info(`Leads Requiring Enrichment: ${stats.leadsToEnrich}`);
  logger.info(`Leads Successfully Enriched: ${stats.enrichedLeads}`);
  logger.info(`Failed Enrichments: ${stats.failedEnrichments}`);
  logger.info(`Contact Discovery Rate: ${successRate}%`);
  logger.info(`Total Contacts Found: ${stats.contactsFound}`);
  logger.info(`Average Time per Lead: ${stats.leadsToEnrich > 0 ? (duration / stats.leadsToEnrich / 1000).toFixed(1) : 0}s`);
}

/**
 * Main enrichment process
 */
async function main() {
  const config = parseArgs();
  
  logger.info('=== OSINT Email Enrichment Started ===');
  logger.info(`Configuration: ${JSON.stringify(config, null, 2)}`);
  
  // Create necessary directories
  createDirectories();
  
  // Load leads from specified sources
  const allLeads = loadLeads(config.sources);
  stats.totalLeads = allLeads.length;
  
  if (allLeads.length === 0) {
    logger.error('No leads found to process. Check your source files.');
    return;
  }
  
  // Filter leads that need enrichment
  const leadsWithContacts = allLeads.filter(hasContacts);
  const leadsToEnrich = allLeads.filter(lead => !hasContacts(lead));
  
  stats.leadsWithContacts = leadsWithContacts.length;
  stats.leadsToEnrich = leadsToEnrich.length;
  
  logger.info(`Found ${stats.leadsWithContacts} leads with existing contacts`);
  logger.info(`Found ${stats.leadsToEnrich} leads requiring enrichment`);
  
  if (stats.leadsToEnrich === 0) {
    logger.info('All leads already have contact information. Nothing to enrich.');
    return;
  }
  
  // Apply limit if specified
  let leadsToProcess = leadsToEnrich;
  if (config.limit && config.limit < leadsToEnrich.length) {
    leadsToProcess = leadsToEnrich.slice(0, config.limit);
    logger.info(`Processing limited set: ${config.limit} leads (--limit flag)`);
  }
  
  if (config.dryRun) {
    logger.info('DRY RUN: Would process the following leads:');
    leadsToProcess.forEach((lead, index) => {
      logger.info(`  ${index + 1}. ${lead.name} (${lead.domain})`);
    });
    return;
  }
  
  // Create backup before starting
  createBackup(config.sources, config.dryRun);
  
  // Process leads with OSINT enrichment
  logger.info(`Starting OSINT enrichment for ${leadsToProcess.length} leads...`);
  
  const enrichedLeads = [];
  
  for (let i = 0; i < leadsToProcess.length; i++) {
    const lead = leadsToProcess[i];
    const enrichedLead = await enrichLead(lead, i, leadsToProcess.length);
    enrichedLeads.push(enrichedLead);
    
    // Add delay between requests to avoid rate limiting
    if (i < leadsToProcess.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  // Add leads that already had contacts
  enrichedLeads.push(...leadsWithContacts);
  
  // Save results
  saveEnrichedLeads(enrichedLeads, config.dryRun);
  
  // Display final statistics
  displayStats();
  
  logger.success('OSINT enrichment completed successfully!');
}

// Run the enrichment process
if (require.main === module) {
  main().catch(error => {
    logger.error('Enrichment process failed:', error);
    process.exit(1);
  });
}

module.exports = {
  enrichLead,
  loadLeads,
  hasContacts,
  prepareProjectData,
  mergeOsintResults
};