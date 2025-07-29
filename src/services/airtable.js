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
  const records = await base(tableName)
    .select({ filterByFormula: filter, maxRecords: 1 })
    .firstPage();
  return records.length > 0 ? records[0] : null;
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
    'Website': lead.website || '',
    'Status': lead.status || 'New Lead',
    'Source': lead.source || 'ICODrops',
    'Twitter': lead.twitter || '',
    'LinkedIn': lead.linkedin || '',
    'Date Added': new Date().toISOString().split('T')[0]
  };
  
  // Add optional fields if they exist (only if field exists in Airtable)
  if (lead.email) fields['Email'] = lead.email;
  if (lead.telegram) fields['Telegram'] = lead.telegram;

  const existing = await findRecordByDomain(lead.domain);
  if (existing) {
    await base(tableName).update([{
      id: existing.id,
      fields: fields
    }]);
    return existing.id;
  }
  const created = await base(tableName).create([{
    fields: fields
  }]);
  return created[0].id;
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

module.exports = { findRecordByDomain, upsertLead, upsertLeads };