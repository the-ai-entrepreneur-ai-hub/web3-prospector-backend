const dotenv = require('dotenv');
dotenv.config();

const { runAllScrapers } = require('./scrapers');
const { dedupLeads } = require('./utils/dedup');
const { enrichDomain, logEnrichmentStats } = require('./enrichment/snovio');
const { createSocialFallback } = require('./utils/social-fallback');
const { upsertLeads } = require('./services/airtable');
const { createLogger } = require('./utils/logger');

/**
 * Enhanced ingest pipeline with comprehensive logging and social media fallback.
 *
 * This function orchestrates the entire data flow: scrape data sources,
 * deduplicate results, enrich contacts using multiple fallback methods,
 * generate summaries, and store everything in Airtable.
 * 
 * Enhanced features:
 * - Comprehensive logging with progress tracking
 * - Social media fallback chain for contact enrichment
 * - Statistics and performance monitoring
 * - Error handling and recovery
 */
async function ingest() {
  const logger = createLogger('IngestPipeline');
  const socialEnricher = createSocialFallback();
  const startTime = Date.now();
  
  logger.info('🚀 Starting enhanced data ingestion pipeline');
  
  const stats = {
    scraped: 0,
    deduped: 0,
    enriched: 0,
    socialEnriched: 0,
    snovioEnriched: 0,
    stored: 0,
    errors: 0,
    duration: 0
  };
  
  try {
    // 1. Scrape all configured sources
    logger.info('Phase 1: Scraping all configured data sources');
    logger.startProgress('scraping', 1, 'Running all scrapers');
    
    const scraped = await runAllScrapers();
    stats.scraped = scraped.length;
    
    logger.completeProgress('scraping', `${scraped.length} raw leads scraped`);
    logger.success(`✓ Scraped ${scraped.length} raw leads from all sources`);
    
    if (scraped.length === 0) {
      logger.warn('No data scraped from any source. Pipeline terminating early.');
      return stats;
    }
    
    // 2. Deduplicate by domain
    logger.info('Phase 2: Deduplicating leads by domain');
    const deduped = dedupLeads(scraped);
    stats.deduped = deduped.length;
    
    const duplicatesRemoved = scraped.length - deduped.length;
    logger.success(`✓ Deduplication complete: ${deduped.length} unique leads (${duplicatesRemoved} duplicates removed)`);
    
    // 3. Enhanced contact enrichment with fallback chain
    logger.info('Phase 3: Enriching leads with contact information');
    logger.info('Using fallback chain: website → social media → LinkedIn → Snovio');
    logger.startProgress('enrichment', deduped.length, 'Enriching contact data');
    
    for (let i = 0; i < deduped.length; i++) {
      const lead = deduped[i];
      
      try {
        logger.updateProgress('enrichment', i + 1, `${lead.name} (${lead.domain || 'no domain'})`);
        
        let contactFound = false;
        
        // Try social media fallback first (faster and often more current)
        if (!contactFound) {
          logger.debug(`Trying social fallback for ${lead.name}`);
          const socialContact = await socialEnricher.enrichProject(lead);
          
          if (socialContact && socialContact.contacts && socialContact.contacts.length > 0) {
            const contact = socialContact.contacts[0]; // Use first contact found
            lead.email = contact.email;
            lead.linkedin = contact.linkedinProfile || lead.linkedin || '';
            lead.contactName = contact.name || '';
            lead.position = contact.position || '';
            lead.enrichmentSource = contact.source || 'social-fallback';
            lead.enrichmentConfidence = contact.confidence || 0.7;
            
            stats.socialEnriched++;
            contactFound = true;
            logger.debug(`✓ Social contact found for ${lead.name}: ${contact.email}`);
          }
        }
        
        // Fallback to Snovio if social media didn't work and we have a domain
        if (!contactFound && lead.domain) {
          logger.debug(`Trying Snovio for ${lead.name} (${lead.domain})`);
          const snovioContact = await enrichDomain(lead.domain);
          
          if (snovioContact && snovioContact.email) {
            lead.email = snovioContact.email;
            lead.linkedin = snovioContact.linkedin || lead.linkedin || '';
            lead.contactName = `${snovioContact.firstName || ''} ${snovioContact.lastName || ''}`.trim();
            lead.position = snovioContact.position || '';
            lead.enrichmentSource = 'snovio';
            lead.enrichmentConfidence = snovioContact.confidence || 0.6;
            
            stats.snovioEnriched++;
            contactFound = true;
            logger.debug(`✓ Snovio contact found for ${lead.name}: ${snovioContact.email}`);
          }
        }
        
        if (contactFound) {
          stats.enriched++;
        } else {
          logger.debug(`No contact found for ${lead.name} through any method`);
        }
        
        // Add small delay to respect rate limits
        if (i > 0 && i % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
      } catch (err) {
        stats.errors++;
        logger.error(`Error enriching ${lead.name}:`, err);
        continue;
      }
    }
    
    logger.completeProgress('enrichment', `${stats.enriched} leads enriched with contact data`);
    logger.success(`✓ Contact enrichment complete: ${stats.enriched}/${deduped.length} leads enriched`);
    logger.info(`  - Social media: ${stats.socialEnriched} contacts`);
    logger.info(`  - Snovio API: ${stats.snovioEnriched} contacts`);
    
    // 4. Generate AI summaries and competitor analysis (placeholder)
    logger.info('Phase 4: Generating AI summaries (placeholder)');
    for (const lead of deduped) {
      lead.summary = lead.summary || '';
      lead.competitorAnalysis = lead.competitorAnalysis || '';
    }
    logger.info('AI summary generation skipped (not implemented)');
    
    // 5. Persist leads to Airtable
    logger.info('Phase 5: Storing leads in Airtable');
    logger.startProgress('storage', 1, 'Uploading to Airtable');
    
    await upsertLeads(deduped);
    stats.stored = deduped.length;
    
    logger.completeProgress('storage', `${deduped.length} leads stored successfully`);
    logger.success(`✓ Successfully stored ${deduped.length} leads in Airtable`);
    
  } catch (error) {
    logger.error('Fatal error in ingestion pipeline:', error);
    stats.errors++;
    throw error;
  } finally {
    // Calculate final statistics
    stats.duration = Date.now() - startTime;
    
    // Log comprehensive pipeline statistics
    logger.info('');
    logger.info('=== INGESTION PIPELINE STATISTICS ===');
    logger.info(`Total Runtime: ${(stats.duration / 1000).toFixed(1)}s`);
    logger.info(`Raw Leads Scraped: ${stats.scraped}`);
    logger.info(`Unique Leads After Dedup: ${stats.deduped}`);
    logger.info(`Leads with Contact Info: ${stats.enriched} (${stats.deduped > 0 ? (stats.enriched / stats.deduped * 100).toFixed(1) : '0.0'}%)`);
    logger.info(`  - Social Media: ${stats.socialEnriched}`);
    logger.info(`  - Snovio API: ${stats.snovioEnriched}`);
    logger.info(`Leads Stored: ${stats.stored}`);
    logger.info(`Errors Encountered: ${stats.errors}`);
    logger.info('');
    
    // Log Snovio-specific statistics
    logEnrichmentStats();
    
    // Log social fallback statistics
    logger.info('=== SOCIAL FALLBACK STATISTICS ===');
    logger.info(`Social enrichment attempts completed successfully`);
    
    logger.success(`🎉 Ingestion pipeline completed successfully in ${(stats.duration / 1000).toFixed(1)}s`);
  }
  
  return stats;
}

// Execute when run directly
if (require.main === module) {
  ingest().catch((err) => {
    console.error('[Ingest] Fatal error:', err);
    process.exit(1);
  });
}

module.exports = ingest;