const { PlaywrightHelper } = require('../utils/playwright-helper');
const { exec } = require('child_process');
const dns = require('dns').promises;
const axios = require('axios');

// Load environment variables
require('dotenv').config();

// Import your existing Snov.io API integration
const { enrichDomain, getAccessToken } = require('../enrichment/snovio');

/**
 * Windows-compatible OSINT email discovery module
 * Uses existing PlaywrightHelper instead of direct chromium.launch()
 */

/**
 * Run a WHOIS lookup using online API (Windows-compatible)
 */
async function performWhoisLookup(domain) {
  try {
    // Use online whois API instead of command line
    const response = await axios.get(`https://api.whoisjson.com/v1/whois?domain=${domain}`, {
      timeout: 10000
    });
    
    if (response.data && response.data.raw) {
      const match = response.data.raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      return match ? match[0] : '';
    }
  } catch (error) {
    // Fallback: try another API or skip
    try {
      const response = await axios.get(`https://jsonwhois.com/api/v1/whois?domain=${domain}`, {
        timeout: 10000
      });
      
      if (response.data && response.data.raw) {
        const match = response.data.raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        return match ? match[0] : '';
      }
    } catch (fallbackError) {
      // Skip whois if both APIs fail
    }
  }
  
  return '';
}

/**
 * Extract email addresses and potential names from an arbitrary page.
 */
async function scrapeEmailsFromPage(page) {
  return await page.evaluate(() => {
    const results = [];

    // Extract from mailto links.
    document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
      const email = a.getAttribute('href').replace(/^mailto:/, '').trim();
      const name = a.textContent.trim();
      results.push({ email, name });
    });

    // Extract plain text emails.
    const bodyText = document.body.innerText;
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emails = new Set(bodyText.match(emailRegex) || []);
    emails.forEach((email) => {
      results.push({ email, name: '' });
    });

    // Extract Person microdata (schema.org)
    document.querySelectorAll('[itemtype="http://schema.org/Person"]').forEach((personEl) => {
      const name = personEl.querySelector('[itemprop="name"]')?.textContent?.trim() || '';
      const email = personEl.querySelector('[itemprop="email"]')?.textContent?.trim() || '';
      if (email) {
        results.push({ email, name });
      }
    });
    return results;
  });
}

/**
 * Crawl a website using existing PlaywrightHelper
 */
async function crawlWebsite(baseUrl, playHelper) {
  const paths = ['', '/about', '/team', '/blog', '/press', '/contact', '/contact-us'];
  const emails = [];
  const linkedDomains = new Set();

  for (const path of paths) {
    const url = new URL(path, baseUrl).toString();
    try {
      await playHelper.navigateTo(url);
      const pageEmails = await scrapeEmailsFromPage(playHelper.page);
      emails.push(...pageEmails);
      
      // Look for links to external personal websites.
      const foundLinks = await playHelper.page.evaluate(() => {
        const links = [];
        document.querySelectorAll('a[href]').forEach((a) => {
          const href = a.href;
          try {
            const urlObj = new URL(href);
            if (urlObj.hostname && !urlObj.hostname.endsWith(location.hostname)) {
              links.push(urlObj.hostname);
            }
          } catch (e) {
            // ignore invalid URLs
          }
        });
        return links;
      });
      foundLinks.forEach((d) => linkedDomains.add(d));
    } catch (err) {
      // Ignore page failures.
      console.log(`Failed to crawl ${url}: ${err.message}`);
    }
  }
  return { emails, linkedDomains: Array.from(linkedDomains) };
}

/**
 * Scrape a Twitter profile using PlaywrightHelper
 */
async function scrapeTwitterProfile(handle, playHelper) {
  const result = { emails: [], handles: [], names: [] };
  
  try {
    await playHelper.navigateTo(`https://twitter.com/${handle}`);
    
    // Accept cookies or sign‑in prompts if present by pressing Esc.
    try { 
      await playHelper.page.keyboard.press('Escape'); 
    } catch (_) {}
    
    // Wait a bit for content to load
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const { bioText, websiteUrl, pinnedText, displayName } = await playHelper.page.evaluate(() => {
      const bioEl = document.querySelector('div[data-testid="UserDescription"]');
      const bioText = bioEl ? bioEl.innerText : '';
      const websiteEl = document.querySelector('a[data-testid="UserUrl"]');
      const websiteUrl = websiteEl ? websiteEl.href : '';
      const pinnedEl = document.querySelector('article [data-testid="tweetText"]');
      const pinnedText = pinnedEl ? pinnedEl.innerText : '';
      const displayName = document.querySelector('div[data-testid="UserName"] span')?.innerText || '';
      return { bioText, websiteUrl, pinnedText, displayName };
    });
    
    // Extract emails from bio and pinned tweet.
    const combined = `${bioText}\n${pinnedText}`;
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const foundEmails = combined.match(emailRegex) || [];
    result.emails.push(...foundEmails);
    
    // Extract @handles from bio.
    const handleRegex = /@([a-zA-Z0-9_]{1,15})/g;
    let match;
    while ((match = handleRegex.exec(bioText)) !== null) {
      if (match[1].toLowerCase() !== handle.toLowerCase()) {
        result.handles.push(match[1]);
      }
    }
    if (websiteUrl) {
      result.handles.push(websiteUrl);
    }
    if (displayName) {
      result.names.push(displayName);
    }
  } catch (err) {
    console.log(`Failed to scrape Twitter @${handle}: ${err.message}`);
  }
  
  return result;
}

/**
 * Scrape a Telegram public channel using PlaywrightHelper
 */
async function scrapeTelegram(handle, playHelper) {
  const emails = [];
  
  try {
    await playHelper.navigateTo(`https://t.me/${handle}`);
    
    // Wait for content to load
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const text = await playHelper.page.evaluate(() => document.body.innerText);
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const matches = text.match(emailRegex) || [];
    emails.push(...matches);
  } catch (err) {
    console.log(`Failed to scrape Telegram @${handle}: ${err.message}`);
  }
  
  return emails;
}

/**
 * Generate email permutations
 */
function generateEmailPermutations(firstName, lastName, domain) {
  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = lastName.toLowerCase().replace(/[^a-z]/g, '');
  const permutations = new Set();
  if (f && l) {
    permutations.add(`${f}.${l}@${domain}`);
    permutations.add(`${f}${l[0]}@${domain}`);
    permutations.add(`${f[0]}.${l}@${domain}`);
    permutations.add(`${f}${l}@${domain}`);
  }
  if (f) {
    permutations.add(`${f}@${domain}`);
  }
  if (l) {
    permutations.add(`${l}@${domain}`);
  }
  return Array.from(permutations);
}

/**
 * Check whether an email's domain has valid MX records
 */
async function hasValidMX(email) {
  const domain = email.split('@')[1];
  try {
    const records = await dns.resolveMx(domain);
    return records && records.length > 0;
  } catch (e) {
    return false;
  }
}

/**
 * Rank email candidates
 */
function rankCandidates(candidates, projectDomain) {
  const scores = {};
  const occurrences = {};
  candidates.forEach(({ email, source, verified }) => {
    const key = email.toLowerCase();
    scores[key] = scores[key] || 0;
    occurrences[key] = occurrences[key] || new Set();
    if (verified) scores[key] += 40;
    if (email.split('@')[1] === projectDomain) scores[key] += 10;
    occurrences[key].add(source);
  });
  Object.keys(scores).forEach((key) => {
    const count = occurrences[key].size;
    if (count > 1) scores[key] += 20;
  });
  const sorted = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  return {
    primary: sorted[0] || '',
    alternates: sorted.slice(1),
  };
}

/**
 * Main entry point - Windows compatible version
 */
async function discoverProjectEmails(project) {
  console.log(`\n=== Starting OSINT Discovery for ${project.name} ===`);
  
  const playHelper = new PlaywrightHelper({
    headless: true,
    timeout: 30000,
    retries: 2
  });
  
  const result = {
    project: project.name,
    primary_email: '',
    alternate_emails: [],
    evidence: { twitter: '', telegram: '', website: '', whois: '' },
    verification_status: 'unverifiable',
  };
  const candidates = [];

  try {
    // Initialize browser
    await playHelper.initialize();

    // 1. Domain Intelligence
    const domain = new URL(project.website).hostname.replace(/^www\./, '');
    console.log(`Domain: ${domain}`);
    
    // WHOIS lookup
    const whoisEmail = await performWhoisLookup(domain);
    if (whoisEmail) {
      candidates.push({ email: whoisEmail, source: 'whois', verified: false });
      result.evidence.whois = whoisEmail;
      console.log(`✓ WHOIS found: ${whoisEmail}`);
    } else {
      console.log(`✗ WHOIS: No email found for ${domain}`);
    }
    
    // Domain search via Snov.io API
    try {
      console.log(`Attempting Snov.io enrichment for domain: ${domain}`);
      const snovioResult = await enrichDomain(domain);
      if (snovioResult && snovioResult.email) {
        const isDecisionMaker = /\b(ceo|founder|co-?founder|chief|lead|director|president|owner)\b/i.test(snovioResult.position || '');
        candidates.push({ 
          email: snovioResult.email, 
          source: 'snovio', 
          verified: snovioResult.emailStatus === 'valid',
          name: `${snovioResult.firstName} ${snovioResult.lastName}`.trim(),
          position: snovioResult.position,
          isDecisionMaker
        });
        console.log(`✓ Snov.io found: ${snovioResult.email} (${snovioResult.firstName} ${snovioResult.lastName})`);
      } else {
        console.log(`✗ Snov.io: No results for ${domain}`);
      }
    } catch (err) {
      console.log(`✗ Snov.io error for ${domain}: ${err.message}`);
    }

    // 2. Website Scrape
    console.log(`Scraping website: ${project.website}`);
    const { emails: websiteEmails, linkedDomains } = await crawlWebsite(project.website, playHelper);
    websiteEmails.forEach(({ email, name }) => {
      candidates.push({ email, source: 'website', verified: false });
    });
    result.evidence.website = websiteEmails.length ? project.website : '';
    console.log(`✓ Website scraping found ${websiteEmails.length} emails`);

    // 3. Twitter OSINT
    if (project.twitter) {
      console.log(`Scraping Twitter: @${project.twitter}`);
      const twitterData = await scrapeTwitterProfile(project.twitter, playHelper);
      twitterData.emails.forEach((email) => {
        candidates.push({ email, source: 'twitter', verified: false });
      });
      console.log(`✓ Twitter scraping found ${twitterData.emails.length} emails`);
      result.evidence.twitter = twitterData.emails[0] || '';
    }

    // 4. Telegram OSINT
    if (project.telegram) {
      console.log(`Scraping Telegram: @${project.telegram}`);
      const telegramEmails = await scrapeTelegram(project.telegram, playHelper);
      telegramEmails.forEach((email) => {
        candidates.push({ email, source: 'telegram', verified: false });
      });
      result.evidence.telegram = telegramEmails[0] || '';
      console.log(`✓ Telegram scraping found ${telegramEmails.length} emails`);
    }

    // 5. Email Permutations
    const names = [];
    websiteEmails.forEach(({ name }) => {
      if (name && name.split(' ').length >= 2) {
        names.push(name);
      }
    });

    console.log(`Generating permutations for ${names.length} names found`);
    for (const fullName of names) {
      const parts = fullName.split(/\s+/);
      const first = parts[0];
      const last = parts[parts.length - 1];
      const perms = generateEmailPermutations(first, last, domain);
      for (const email of perms) {
        if (!(await hasValidMX(email))) continue;
        const verified = false;
        candidates.push({ email, source: 'permutation', verified });
      }
    }

    // 6. Cross‑Source Correlation & Ranking
    console.log(`Total candidates found: ${candidates.length}`);
    
    if (candidates.length > 0) {
      candidates.forEach((candidate, index) => {
        console.log(`  ${index + 1}. ${candidate.email} (${candidate.source}${candidate.verified ? ', verified' : ''})`);
      });
    }
    
    const { primary, alternates } = rankCandidates(candidates, domain);
    result.primary_email = primary;
    result.alternate_emails = alternates;
    
    const primaryCandidate = candidates.find((c) => c.email === primary);
    if (primaryCandidate) {
      result.verification_status = primaryCandidate.verified ? 'valid' : 'unverifiable';
    }
    
    if (primary) {
      console.log(`✓ Selected primary email: ${primary}`);
    } else {
      console.log(`✗ No primary email selected from ${candidates.length} candidates`);
    }

  } catch (error) {
    console.error(`OSINT discovery failed for ${project.name}:`, error.message);
  } finally {
    await playHelper.cleanup();
  }

  return result;
}

module.exports = {
  performWhoisLookup,
  scrapeEmailsFromPage,
  crawlWebsite,
  scrapeTwitterProfile,
  scrapeTelegram,
  generateEmailPermutations,
  hasValidMX,
  rankCandidates,
  discoverProjectEmails,
};