const Airtable = require('airtable');

/**
 * Airtable service module
 *
 * This module wraps the Airtable API into simple helper functions for
 * retrieving and upserting leads. It expects the following environment
 * variables to be defined:
 *  - AIRTABLE_API_KEY: Your Airtable personal access token
 *  - AIRTABLE_BASE_ID: The ID of your Airtable base
 *  - AIRTABLE_TABLE_NAME: Name of the table where leads are stored
 */

const baseId = process.env.AIRTABLE_BASE_ID;
const tableName = process.env.AIRTABLE_TABLE_NAME || 'Leads';

if (!process.env.AIRTABLE_API_KEY || !baseId) {
  console.warn('Airtable integration is disabled. Missing API key or Base ID.');
}

// Lazily instantiate the Airtable base only when needed
let airtableBase;
function getBase() {
  if (!process.env.AIRTABLE_API_KEY) {
    throw new Error('AIRTABLE_API_KEY is not set.');
  }
  if (!airtableBase) {
    const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
    airtableBase = airtable.base(baseId);
  }
  return airtableBase;
}

/**
 * Find a lead record in Airtable by its domain.
 *
 * Airtable's API supports filterByFormula to search for records. We use
 * FIND() to perform a case‑insensitive search on the Domain field. If
 * multiple records match the same domain (which should not happen), the
 * first record is returned.
 *
 * @param {string} domain The domain to search for (e.g. 'example.com').
 * @returns {Promise<Object|null>} The Airtable record, or null if not found.
 */
async function findRecordByDomain(domain) {
  if (!process.env.AIRTABLE_API_KEY) return null;
  const base = getBase();
  const filter = `FIND('${domain}', {Website}) > 0`;
  try {
    const records = await base(tableName)
      .select({ filterByFormula: filter, maxRecords: 1 })
      .firstPage();
    return records.length > 0 ? records[0] : null;
  } catch (error) {
    // If Website field doesn't exist or is empty, return null
    console.warn(`Domain matching failed for ${domain}: ${error.message}`);
    return null;
  }
}

/**
 * Find a lead record in Airtable by project name.
 * Since Website field is often empty, we use Project Name as backup.
 */
async function findRecordByName(projectName) {
  if (!process.env.AIRTABLE_API_KEY) return null;
  const base = getBase();
  // Exact match on Project Name  
  const filter = `{Project Name} = '${projectName.replace(/'/g, "\\\\'")}'`;
  try {
    const records = await base(tableName)
      .select({ filterByFormula: filter, maxRecords: 1 })
      .firstPage();
    return records.length > 0 ? records[0] : null;
  } catch (error) {
    console.warn(`Name matching failed for ${projectName}: ${error.message}`);
    return null;
  }
}

/**
 * Create or update a lead record in Airtable.
 *
 * The function checks whether the lead already exists by domain. If it does,
 * the record is updated; otherwise, a new record is created. Field names in
 * Airtable may differ from the keys of the lead object; adjust the mapping
 * accordingly in the `fields` object.
 *
 * @param {Object} lead The lead data to upsert. Must contain at least
 * `name`, `website`, and `domain`.
 * @returns {Promise<string>} The Airtable record ID for the upserted lead.
 */
async function upsertLead(lead) {
  if (!process.env.AIRTABLE_API_KEY) {
    console.warn('Airtable is disabled; skipping upsert.');
    return '';
  }
  const base = getBase();
  // Build the payload fields; adjust names to match your Airtable schema
  const fields = {
    'Project Name': lead.name || '',
    'Status': lead.status || 'New Lead',
    'Source': lead.source || 'ICODrops',
    'Date Added': new Date().toISOString().split('T')[0]
  };
  
  // Only add fields that exist in Airtable schema
  // These fields need to be added to your Airtable table first
  if (lead.website) fields['Website'] = lead.website;
  if (lead.email) fields['Email'] = lead.email;
  if (lead.twitter) fields['Twitter'] = lead.twitter;
  if (lead.linkedin) fields['LinkedIn'] = lead.linkedin;
  if (lead.telegram) fields['Telegram'] = lead.telegram;
  if (lead.contactName) fields['Contact Name'] = lead.contactName;
  if (lead.position) fields['Position'] = lead.position;
  // Skip Enrichment Source field - not in Airtable schema
  // if (lead.enrichmentSource) fields['Enrichment Source'] = lead.enrichmentSource;
  // if (lead.enrichmentConfidence) fields['Enrichment Confidence'] = lead.enrichmentConfidence;
  
  // Handle contacts array - store as JSON string or pick best contact
  if (lead.contacts && Array.isArray(lead.contacts) && lead.contacts.length > 0) {
    // Store the best contact in primary fields if not already set
    const bestContact = lead.contacts[0]; // Already sorted by decision maker score
    
    if (!lead.email && bestContact.email) {
      fields['Email'] = bestContact.email;
    }
    if (!lead.contactName && bestContact.name) {
      fields['Contact Name'] = bestContact.name;
    }
    if (!lead.position && bestContact.position) {
      fields['Position'] = bestContact.position;
    }
    if (!lead.enrichmentSource && bestContact.source) {
      fields['Enrichment Source'] = bestContact.source;
    }
    if (!lead.enrichmentConfidence && bestContact.confidence) {
      fields['Enrichment Confidence'] = bestContact.confidence;
    }
    
    // Store all contacts as JSON in a notes field (if available)
    try {
      fields['All Contacts'] = JSON.stringify(lead.contacts.slice(0, 5)); // Limit to 5 contacts
    } catch (error) {
      // JSON stringify failed, skip
    }
  }

  // Try to find existing record by domain first, then by name
  let existing = await findRecordByDomain(lead.domain);
  if (!existing && lead.name) {
    existing = await findRecordByName(lead.name);
  }
  if (existing) {
    try {
      await base(tableName).update([{
        id: existing.id,
        fields: fields
      }]);
      return existing.id;
    } catch (error) {
      if (error.message.includes('Unknown field name')) {
        console.warn(`⚠️ Airtable field missing: ${error.message}`);
        console.warn('Please add missing fields to your Airtable table');
      }
      throw error;
    }
  }
  
  try {
    const created = await base(tableName).create([{
      fields: fields
    }]);
    return created[0].id;
  } catch (error) {
    if (error.message.includes('Unknown field name')) {
      console.warn(`⚠️ Airtable field missing: ${error.message}`);
      console.warn('Please add missing fields to your Airtable table');
    }
    throw error;
  }
}

/**
 * Fetch all existing leads from Airtable
 *
 * @returns {Promise<Array<Object>>} Array of lead objects
 */
async function fetchAllLeads() {
  if (!process.env.AIRTABLE_API_KEY) {
    console.warn('Airtable is disabled; returning empty array.');
    return [];
  }
  
  const base = getBase();
  const leads = [];
  
  try {
    await base(tableName).select({
      // You can add any filtering here if needed
      // filterByFormula: `{Status} != 'Processed'`,
      maxRecords: 1000 // Adjust as needed
    }).eachPage((records, fetchNextPage) => {
      records.forEach(record => {
        const fields = record.fields;
        
        // Map Airtable fields back to lead object structure
        const lead = {
          id: record.id,
          name: fields['Project Name'] || '',
          website: fields['Website'] || '',
          domain: extractDomainFromWebsite(fields['Website'] || ''),
          status: fields['Status'] || 'New Lead',
          source: fields['Source'] || '',
          twitter: fields['Twitter'] || '',
          linkedin: fields['LinkedIn'] || '',
          email: fields['Email'] || '',
          telegram: fields['Telegram'] || '',
          contactName: fields['Contact Name'] || '',
          position: fields['Position'] || '',
          enrichmentSource: fields['Enrichment Source'] || '',
          enrichmentConfidence: fields['Enrichment Confidence'] || 0,
          contacts: [], // Initialize empty contacts array
          dateAdded: fields['Date Added'] || ''
        };
        
        leads.push(lead);
      });
      
      fetchNextPage();
    });
    
    console.log(`Fetched ${leads.length} existing leads from Airtable`);
    return leads;
    
  } catch (error) {
    console.error('Error fetching leads from Airtable:', error);
    return [];
  }
}

/**
 * Extract domain from website URL
 * @param {string} website 
 * @returns {string}
 */
function extractDomainFromWebsite(website) {
  if (!website) return '';
  
  try {
    // Remove protocol
    let domain = website.replace(/^https?:\/\//, '');
    // Remove www
    domain = domain.replace(/^www\./, '');
    // Remove path
    domain = domain.split('/')[0];
    // Remove port
    domain = domain.split(':')[0];
    
    return domain.toLowerCase();
  } catch (error) {
    return website;
  }
}

/**
 * Bulk upsert multiple leads sequentially.
 *
 * Many API providers (including Airtable) have rate limits on the number of
 * requests per second. This helper iterates through the list of leads and
 * calls `upsertLead` for each one. If you expect a very large number of
 * leads, consider batching calls or adding delays between requests.
 *
 * @param {Array<Object>} leads
 */
async function upsertLeads(leads) {
  for (const lead of leads) {
    try {
      await upsertLead(lead);
    } catch (err) {
      console.error(`Error upserting lead for domain ${lead.domain}:`, err.message);
    }
  }
}

module.exports = { findRecordByDomain, findRecordByName, upsertLead, upsertLeads, fetchAllLeads };