/**
 * Extract domain from website URL
 * 
 * @param {string} website Website URL
 * @returns {string} Extracted domain
 */
function extractDomain(website) {
  if (!website) return null;
  try {
    const url = new URL(website);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch (err) {
    // If parsing fails just use the original string
    return website.toLowerCase();
  }
}

/**
 * Deduplicate a list of leads based on domain names.
 *
 * Some sources may provide duplicate projects (e.g. a project listed on both
 * CryptoRank and ICODrops). We deduplicate by normalising the domain and
 * keeping the first occurrence. Additional information from subsequent
 * duplicates is merged in when available.
 *
 * @param {Array<Object>} leads Array of lead objects. Each object must
 * include at least a `website` property.
 * @returns {Array<Object>} Deduplicated list of leads.
 */
function dedupLeads(leads) {
  const map = new Map();
  for (const lead of leads) {
    if (!lead.website) continue;
    const domain = extractDomain(lead.website);
    if (!map.has(domain)) {
      map.set(domain, { ...lead, domain });
    } else {
      // Merge fields from duplicate into the existing record if they
      // contain missing values. This helps preserve as much information as
      // possible without creating duplicate records in Airtable.
      const existing = map.get(domain);
      for (const key of Object.keys(lead)) {
        if (lead[key] && !existing[key]) {
          existing[key] = lead[key];
        }
      }
      map.set(domain, existing);
    }
  }
  return Array.from(map.values());
}

module.exports = { dedupLeads, extractDomain };