require('dotenv').config();

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const fs = require('fs').promises;
const path = require('path');
const { runAllScrapers } = require('./scrapers');
const { dedupLeads } = require('./utils/dedup');
const { enrichDomain, enrichDomainWithRealNames, enrichDomainWithFusion, logEnrichmentStats, verifyCredentials, verifyEmail } = require('./enrichment/snovio');
const { createSocialFallback } = require('./utils/social-fallback');
const { createWebsiteContactScraper } = require('./utils/website-contact-scraper');
const { upsertLeads, fetchAllLeads } = require('./services/airtable');
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
 * - CLI mode support for enrichment-only operations
 */
async function ingest(options = {}) {
  const logger = createLogger('IngestPipeline');
  const socialEnricher = createSocialFallback();
  const websiteContactScraper = createWebsiteContactScraper();
  const startTime = Date.now();
  
  // Apply CLI options
  const {
    mode = 'full',
    source = 'scraped',
    updateOnly = false,
    noUpload = false,
    outputPath = null,
    limit = null,
    verifyEmails = true,
    disableAirtable = process.env.DISABLE_AIRTABLE === 'true'
  } = options;
  
  logger.info(`🚀 Starting enhanced data ingestion pipeline (mode: ${mode}, source: ${source})`);
  
  if (mode === 'enrich-only') {
    logger.info('Enrichment-only mode: skipping scraping phase');
  }
  
  if (updateOnly) {
    logger.info('Update-only mode: preserving existing contact data');
  }
  
  if (noUpload || disableAirtable) {
    logger.info('Upload disabled: results will only be saved locally');
  }
  
  // Verify API credentials before starting
  if (mode !== 'scrape-only') {
    logger.info('Verifying Snov.io API credentials...');
    const credentialsValid = await verifyCredentials();
    if (!credentialsValid) {
      logger.warn('Snov.io credentials verification failed. Enrichment may not work properly.');
    } else {
      logger.success('✓ Snov.io credentials verified successfully');
    }
  }
  
  const stats = {
    scraped: 0,
    deduped: 0,
    enriched: 0,
    socialEnriched: 0,
    snovioEnriched: 0,
    websiteEnriched: 0,
    emailsVerified: 0,
    emailsSkipped: 0,
    stored: 0,
    errors: 0,
    duration: 0,
    fromExisting: 0,
    updated: 0,
    preserved: 0
  };
  
  try {
    let deduped = [];
    
    if (mode === 'enrich-only' && source === 'existing') {
      // Load existing data from Airtable
      logger.info('Phase 1: Loading existing leads from Airtable');
      logger.startProgress('loading', 1, 'Fetching from Airtable');
      
      const existingLeads = await fetchAllLeads();
      stats.fromExisting = existingLeads.length;
      
      // Apply limit if specified
      deduped = limit ? existingLeads.slice(0, limit) : existingLeads;
      stats.deduped = deduped.length;
      
      logger.completeProgress('loading', `${existingLeads.length} existing leads loaded (${deduped.length} selected)`);
      logger.success(`✓ Loaded ${existingLeads.length} existing leads from Airtable`);
      
      if (limit) {
        logger.info(`Limited to ${limit} leads for processing`);
      }
      
    } else if (mode !== 'enrich-only') {
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
      deduped = dedupLeads(scraped);
      stats.deduped = deduped.length;
      
      const duplicatesRemoved = scraped.length - deduped.length;
      logger.success(`✓ Deduplication complete: ${deduped.length} unique leads (${duplicatesRemoved} duplicates removed)`);
    } else {
      logger.error('Invalid configuration: enrich-only mode requires source=existing');
      return stats;
    }
    
    if (deduped.length === 0) {
      logger.warn('No leads to process. Pipeline terminating.');
      return stats;
    }
    
    // 3. Enhanced contact enrichment with fallback chain
    logger.info('Phase 3: Enriching leads with contact information');
    logger.info('Using fallback chain: Snovio → social media → website scraping');
    logger.startProgress('enrichment', deduped.length, 'Enriching contact data');
    
    for (let i = 0; i < deduped.length; i++) {
      const lead = deduped[i];
      
      try {
        logger.updateProgress('enrichment', i + 1, `${lead.name} (${lead.domain || 'no domain'})`);
        
        let contactFound = false;
        
        // Check if we should skip enrichment (update-only mode with existing contact)
        const hasExistingContact = updateOnly && lead.email && lead.email.trim() !== '';
        
        if (hasExistingContact) {
          logger.debug(`Preserving existing contact for ${lead.name}: ${lead.email}`);
          stats.preserved++;
          contactFound = true;
        } else {
          // Step 1: Try Fusion Engine first (GitHub + WHOIS + LinkedIn + patterns)
          if (!contactFound && lead.domain) {
            logger.debug(`Trying Fusion Engine for ${lead.name} (${lead.domain})`);
            const fusionContacts = await enrichDomainWithFusion(lead.domain, {
              name: lead.name,
              website: lead.website,
              domain: lead.domain,
              github: lead.github
            });

            if (fusionContacts && Array.isArray(fusionContacts) && fusionContacts.length > 0) {
              // Initialize contacts array if not exists
              if (!lead.contacts) {
                lead.contacts = [];
              }
              
              // Add all fusion contacts to contacts array
              for (const fusionContact of fusionContacts) {
                const contactEntry = {
                  email: fusionContact.email,
                  name: fusionContact.name || 'Contact',
                  position: fusionContact.position || 'Team Member',
                  source: fusionContact.source || 'fusion-engine',
                  confidence: fusionContact.confidence || 0.9,
                  decisionMakerScore: fusionContact.decisionMakerScore || 7,
                  extractedFrom: fusionContact.extractedFrom || 'public-data-fusion'
                };
                
                // Check if this contact already exists
                const existingContact = lead.contacts.find(c => c.email === contactEntry.email);
                if (!existingContact) {
                  lead.contacts.push(contactEntry);
                }
              }
              
              // Update primary fields with the best contact (highest decision maker score)
              const bestContact = fusionContacts[0]; // Already sorted by decision maker score
              if (!lead.email || bestContact.decisionMakerScore > 0) {
                lead.email = bestContact.email;
                lead.contactName = bestContact.name || 'Contact';
                lead.position = bestContact.position || 'Team Member';
              }
              
              stats.snovioEnriched++;
              contactFound = true;
            }
          }

          // Step 2: Try Enhanced Snovio with real names (fallback)
          if (!contactFound && lead.domain) {
            logger.debug(`Trying Enhanced Snovio with real names for ${lead.name} (${lead.domain})`);
            const snovioContacts = await enrichDomainWithRealNames(lead.domain, {
              name: lead.name,
              website: lead.website,
              domain: lead.domain,
              github: lead.github
            });
            
            if (snovioContacts && Array.isArray(snovioContacts) && snovioContacts.length > 0) {
              // Initialize contacts array if not exists
              if (!lead.contacts) {
                lead.contacts = [];
              }
              
              // Add all contacts to contacts array
              for (const snovioContact of snovioContacts) {
                const contactEntry = {
                  email: snovioContact.email,
                  name: `${snovioContact.firstName || ''} ${snovioContact.lastName || ''}`.trim(),
                  position: snovioContact.position || snovioContact.originalRole || '',
                  linkedinProfile: snovioContact.linkedin || '',
                  source: snovioContact.source || 'snovio-enhanced',
                  confidence: snovioContact.confidence || 0.9,
                  decisionMakerScore: snovioContact.decisionMakerScore || 0,
                  extractedFrom: snovioContact.extractedFrom || ''
                };
                
                // Check if this contact already exists
                const existingContact = lead.contacts.find(c => c.email === contactEntry.email);
                if (!existingContact) {
                  lead.contacts.push(contactEntry);
                }
              }
              
              // Update primary fields with the best contact (highest decision maker score)
              const bestContact = snovioContacts[0]; // Already sorted by decision maker score
              if (!lead.email || bestContact.decisionMakerScore > 0) {
                lead.email = bestContact.email;
                lead.linkedin = bestContact.linkedin || lead.linkedin || '';
                lead.contactName = `${bestContact.firstName || ''} ${bestContact.lastName || ''}`.trim();
                lead.position = bestContact.position || bestContact.originalRole || '';
                lead.enrichmentSource = bestContact.source || 'snovio-enhanced';
                lead.enrichmentConfidence = bestContact.confidence || 0.9;
              }
              
              stats.snovioEnriched++;
              contactFound = true;
              logger.debug(`✓ Snovio contact found for ${lead.name}: ${snovioContact.email}`);
            }
          }
        }
        
        // Step 2: Fallback to social media enrichment
        if (!contactFound) {
          logger.debug(`Trying social fallback for ${lead.name}`);
          const socialContact = await socialEnricher.enrichProject(lead);
          
          if (socialContact && socialContact.contacts && socialContact.contacts.length > 0) {
            // Initialize contacts array if not exists
            if (!lead.contacts) {
              lead.contacts = [];
            }
            
            // Add all found contacts to the array
            for (const contact of socialContact.contacts) {
              const contactEntry = {
                email: contact.email,
                name: contact.name || '',
                position: contact.position || '',
                linkedinProfile: contact.linkedinProfile || '',
                source: contact.source || 'social-fallback',
                confidence: contact.confidence || 0.7,
                decisionMakerScore: 0 // Social fallback doesn't provide this yet
              };
              
              // Check if this contact already exists
              const existingContact = lead.contacts.find(c => c.email === contactEntry.email);
              if (!existingContact) {
                lead.contacts.push(contactEntry);
              }
            }
            
            // Use the first contact for primary fields if not already set
            const contact = socialContact.contacts[0];
            if (!lead.email || !contactFound) {
              lead.email = contact.email;
              lead.linkedin = contact.linkedinProfile || lead.linkedin || '';
              lead.contactName = contact.name || '';
              lead.position = contact.position || '';
              lead.enrichmentSource = contact.source || 'social-fallback';
              lead.enrichmentConfidence = contact.confidence || 0.7;
            }
            
            stats.socialEnriched++;
            contactFound = true;
            logger.debug(`✓ Social contact found for ${lead.name}: ${contact.email}`);
          }
        }
        
        // Step 3: Final fallback - direct website scraping
        if (!contactFound && lead.website) {
          logger.debug(`Trying website scraping for ${lead.name} (${lead.website})`);
          const websiteContact = await websiteContactScraper.scrapeWebsiteContacts(lead.website, lead.name);
          
          if (websiteContact && websiteContact.emails && websiteContact.emails.length > 0) {
            // Initialize contacts array if not exists
            if (!lead.contacts) {
              lead.contacts = [];
            }
            
            // Add all found emails as contacts
            for (let i = 0; i < websiteContact.emails.length; i++) {
              const emailData = websiteContact.emails[i];
              const teamMember = websiteContact.teamMembers[i] || {};
              
              const contactEntry = {
                email: emailData.email,
                name: teamMember.name || '',
                position: teamMember.role || '',
                linkedinProfile: teamMember.linkedin || '',
                source: 'website-scraping',
                confidence: emailData.confidence || 0.6,
                decisionMakerScore: 0 // Website scraping doesn't provide this yet
              };
              
              // Check if this contact already exists
              const existingContact = lead.contacts.find(c => c.email === contactEntry.email);
              if (!existingContact) {
                lead.contacts.push(contactEntry);
              }
            }
            
            // Use the best email for primary fields if not already set
            const bestEmail = websiteContact.emails[0];
            if (!lead.email || !contactFound) {
              lead.email = bestEmail.email;
              lead.contactName = websiteContact.teamMembers.length > 0 ? websiteContact.teamMembers[0].name : '';
              lead.position = websiteContact.teamMembers.length > 0 ? websiteContact.teamMembers[0].role : '';
              lead.enrichmentSource = 'website-scraping';
              lead.enrichmentConfidence = bestEmail.confidence || 0.6;
            }
            
            // Add social handles found during website scraping
            if (Object.keys(websiteContact.socialHandles).length > 0) {
              lead.socialHandles = websiteContact.socialHandles;
            }
            
            stats.websiteEnriched++;
            contactFound = true;
            logger.debug(`✓ Website contact found for ${lead.name}: ${bestEmail.email}`);
          }
        }
        
        if (contactFound) {
          stats.enriched++;
          if (!hasExistingContact) {
            stats.updated++;
          }
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
    logger.info(`  - Snovio API: ${stats.snovioEnriched} contacts`);
    logger.info(`  - Social media: ${stats.socialEnriched} contacts`);
    logger.info(`  - Website scraping: ${stats.websiteEnriched} contacts`);
    
    // Email verification phase (if enabled)
    let verifiedCount = 0;
    let skippedCount = 0;
    let totalEmailsToVerify = 0;
    
    if (verifyEmails && mode !== 'scrape-only') {
      // Count how many leads have emails to verify
      let leadsWithEmails = 0;
      let totalEmailsInData = 0;
      
      for (const lead of deduped) {
        if (lead.email && lead.email.trim() !== '') {
          leadsWithEmails++;
          totalEmailsInData++;
        }
        if (lead.contacts && Array.isArray(lead.contacts)) {
          totalEmailsInData += lead.contacts.filter(c => c.email && c.email.trim() !== '').length;
        }
      }
      
      logger.info(`Phase 3.5: Verifying email addresses (${leadsWithEmails}/${deduped.length} leads have emails, ${totalEmailsInData} total emails to verify)`);
      logger.startProgress('verification', deduped.length, 'Verifying email deliverability');
      
      for (let i = 0; i < deduped.length; i++) {
        const lead = deduped[i];
        logger.updateProgress('verification', i + 1, `Verifying ${lead.name} emails`);
        
        try {
          // Verify primary email if exists
          if (lead.email && lead.email.trim() !== '') {
            totalEmailsToVerify++;
            logger.debug(`Found primary email for ${lead.name}: ${lead.email}`);
            const verification = await verifyEmail(lead.email);
            
            if (verification) {
              lead.emailVerification = {
                status: verification.status,
                result: verification.result,
                isValid: verification.isValid,
                verifiedAt: new Date().toISOString()
              };
              
              // Only keep the email if it's verified as deliverable
              if (!verification.isValid) {
                logger.debug(`Removing unverified primary email for ${lead.name}: ${lead.email} (${verification.status}/${verification.result})`);
                lead.email = '';
                lead.contactName = '';
                lead.position = '';
                lead.enrichmentSource = '';
                lead.enrichmentConfidence = 0;
              } else {
                verifiedCount++;
              }
            } else {
              // If verification failed, remove the email
              logger.debug(`Email verification failed for ${lead.name}: ${lead.email}`);
              lead.email = '';
              lead.contactName = '';
              lead.position = '';
              lead.enrichmentSource = '';
              lead.enrichmentConfidence = 0;
            }
          }
          
          // Verify all contacts in the contacts array
          if (lead.contacts && Array.isArray(lead.contacts) && lead.contacts.length > 0) {
            const verifiedContacts = [];
            
            for (const contact of lead.contacts) {
              if (contact.email && contact.email.trim() !== '') {
                totalEmailsToVerify++;
                const verification = await verifyEmail(contact.email);
                
                if (verification && verification.isValid) {
                  contact.emailVerification = {
                    status: verification.status,
                    result: verification.result,
                    isValid: verification.isValid,
                    verifiedAt: new Date().toISOString()
                  };
                  verifiedContacts.push(contact);
                  
                  // If primary email is empty and this is a verified contact, promote it to primary
                  if (!lead.email || lead.email.trim() === '') {
                    lead.email = contact.email;
                    lead.contactName = contact.name;
                    lead.position = contact.position;
                    lead.linkedin = contact.linkedinProfile || '';
                    lead.enrichmentSource = contact.source;
                    lead.enrichmentConfidence = contact.confidence;
                    lead.emailVerification = contact.emailVerification;
                    verifiedCount++;
                  }
                } else {
                  logger.debug(`Removing unverified contact email for ${lead.name}: ${contact.email} (${verification?.status || 'failed'}/${verification?.result || 'unknown'})`);
                }
              } else {
                // Keep contacts without emails
                verifiedContacts.push(contact);
              }
            }
            
            lead.contacts = verifiedContacts;
          }
          
          // Add small delay to respect rate limits (Snov.io has limits on verification)
          if (i > 0 && i % 5 === 0) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          
        } catch (error) {
          logger.error(`Error verifying emails for ${lead.name}:`, error.message);
          skippedCount++;
          continue;
        }
      }
      
      logger.completeProgress('verification', `${verifiedCount} emails verified as deliverable`);
      logger.success(`✓ Email verification complete: ${verifiedCount} verified, ${skippedCount} skipped, ${totalEmailsToVerify} total emails processed`);
    } else {
      logger.info('Email verification skipped (disabled or scrape-only mode)');
    }
    
    // Update enrichment stats
    stats.emailsVerified = verifiedCount;
    stats.emailsSkipped = skippedCount;
    
    // 4. Generate AI summaries and competitor analysis (placeholder)
    logger.info('Phase 4: Generating AI summaries (placeholder)');
    for (const lead of deduped) {
      lead.summary = lead.summary || '';
      lead.competitorAnalysis = lead.competitorAnalysis || '';
    }
    logger.info('AI summary generation skipped (not implemented)');
    
    // 5. Save output and/or persist leads to Airtable
    if (outputPath) {
      logger.info(`Phase 5a: Saving results to ${outputPath}`);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, JSON.stringify(deduped, null, 2));
      logger.success(`✓ Results saved to ${outputPath}`);
    }
    
    if (!noUpload && !disableAirtable) {
      logger.info('Phase 5b: Storing leads in Airtable');
      logger.startProgress('storage', 1, 'Uploading to Airtable');
      
      await upsertLeads(deduped);
      stats.stored = deduped.length;
      
      logger.completeProgress('storage', `${deduped.length} leads stored successfully`);
      logger.success(`✓ Successfully stored ${deduped.length} leads in Airtable`);
    } else {
      logger.info('Airtable upload skipped (disabled by configuration)');
      stats.stored = 0;
    }
    
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
    logger.info(`  - Snovio API: ${stats.snovioEnriched}`);
    logger.info(`  - Social Media: ${stats.socialEnriched}`);
    logger.info(`  - Website Scraping: ${stats.websiteEnriched}`);
    logger.info(`Emails Verified: ${stats.emailsVerified} (${stats.emailsSkipped} skipped)`);
    if (updateOnly) {
      logger.info(`Contacts Preserved: ${stats.preserved}`);
      logger.info(`Contacts Updated: ${stats.updated}`);
    }
    if (source === 'existing') {
      logger.info(`Leads from Existing: ${stats.fromExisting}`);
    }
    logger.info(`Leads Stored: ${stats.stored}`);
    logger.info(`Errors Encountered: ${stats.errors}`);
    if (outputPath) {
      logger.info(`Output saved to: ${outputPath}`);
    }
    logger.info('');
    
    // Log Snovio-specific statistics
    logEnrichmentStats();
    
    // Log enrichment service statistics
    logger.info('=== ENRICHMENT SERVICE STATISTICS ===');
    logger.info(`Social enrichment attempts completed successfully`);
    websiteContactScraper.logStats();
    
    logger.success(`🎉 Ingestion pipeline completed successfully in ${(stats.duration / 1000).toFixed(1)}s`);
  }
  
  return stats;
}

/**
 * Parse CLI arguments and run the appropriate mode
 */
function parseCliArgs() {
  return yargs(hideBin(process.argv))
    .option('mode', {
      describe: 'Operation mode',
      choices: ['full', 'enrich-only', 'scrape-only'],
      default: 'full'
    })
    .option('source', {
      describe: 'Data source for enrichment',
      choices: ['scraped', 'existing'],
      default: 'scraped'
    })
    .option('update-only', {
      describe: 'Only update leads without existing contacts',
      type: 'boolean',
      default: false
    })
    .option('no-upload', {
      describe: 'Skip uploading to Airtable',
      type: 'boolean',
      default: false
    })
    .option('out', {
      describe: 'Output file path for results',
      type: 'string'
    })
    .option('limit', {
      describe: 'Limit number of leads to process',
      type: 'number'
    })
    .option('no-verify-emails', {
      describe: 'Skip email verification phase',
      type: 'boolean',
      default: false
    })
    .help()
    .alias('help', 'h')
    .example('$0', 'Run full pipeline (scrape + enrich + upload)')
    .example('$0 --mode enrich-only --source existing', 'Enrich existing Airtable records')
    .example('$0 --mode enrich-only --source existing --update-only', 'Only enrich records without contacts')
    .example('$0 --mode enrich-only --source existing --no-upload --out results.json', 'Enrich and save to file')
    .example('$0 --mode enrich-only --source existing --limit 50', 'Enrich first 50 existing records')
    .example('$0 --mode enrich-only --source existing --no-verify-emails', 'Enrich without email verification')
    .argv;
}

// Execute when run directly
if (require.main === module) {
  const args = parseCliArgs();
  
  const options = {
    mode: args.mode,
    source: args.source,
    updateOnly: args['update-only'],
    noUpload: args['no-upload'],
    outputPath: args.out,
    limit: args.limit,
    verifyEmails: !args['no-verify-emails']
  };
  
  ingest(options).catch((err) => {
    console.error('[Ingest] Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { ingest, parseCliArgs };