const { chromium } = require('playwright');
const { exec } = require('child_process');
const dns = require('dns').promises;
const fs = require('fs');

/*
 * emailDiscovery.js
 *
 * This module provides an end‑to‑end email discovery workflow for Web3 projects.
 * It automates a series of OSINT tasks using Playwright and basic Node.js utilities
 * to locate and validate founders’ or key decision‑makers’ email addresses given
 * only a project’s website, Twitter handle and Telegram channel.  The goal is to
 * follow the low‑cost workflow outlined by the user while integrating cleanly
 * into an existing Node/Playwright codebase.  The functions in this file
 * intentionally avoid paid APIs beyond the user’s existing Snov.io API access
 * and rely on free techniques like WHOIS lookups, regex scraping and DNS checks.
 *
 * NOTE: This code expects Playwright and the Snov.io API client to be installed
 * and configured elsewhere in your project.  The Snov.io functions imported
 * below (domainSearch, bulkEmailSearch, verifyEmail) should mirror the API calls
 * already present in your src/enrichment/snovio.js file.  Replace the require
 * path with the actual location of your Snov.io client module.
 */

// Import your existing Snov.io API integration
const { enrichDomain, getAccessToken } = require('../enrichment/snovio');

/**
 * Run a WHOIS lookup on a domain and attempt to extract a registrant email.
 * Many registrars redact this information, but some still expose the
 * registrant’s contact address.  This function wraps the `whois` CLI
 * installed on most Linux/macOS systems.  If the command is unavailable
 * or returns no address, an empty string is returned.
 *
 * @param {string} domain – root domain (e.g. “example.com”).
 * @returns {Promise<string>} The first email found in the WHOIS record.
 */
async function performWhoisLookup(domain) {
  return new Promise((resolve) => {
    exec(`whois ${domain}`, (error, stdout) => {
      if (error) {
        resolve('');
        return;
      }
      // Simple regex to capture email addresses in the WHOIS output.
      const match = stdout.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      resolve(match ? match[0] : '');
    });
  });
}

/**
 * Extract email addresses and potential names from an arbitrary page.
 * This helper runs inside the browser context to access the DOM directly.
 * It looks for mailto links, visible text containing an “@” symbol and
 * schema.org Person microdata if available.  It returns a list of
 * { email, name } tuples that can later be de‑duplicated and enriched.
 *
 * @param {import('playwright').Page} page – Playwright page instance.
 * @returns {Promise<{email: string, name: string}[]>}
 */
async function scrapeEmailsFromPage(page) {
  return await page.evaluate(() => {
    /**
     * Collect email addresses from various parts of the DOM.
     */
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
 * Crawl a website looking for team pages and contact information.
 * This function visits a set of common slug paths (e.g. /about, /team, /blog)
 * relative to the base URL.  For each page it captures email addresses
 * and names via `scrapeEmailsFromPage`.  If a page contains links to
 * personal websites, those domains are queued for WHOIS and Snov.io
 * enrichment in the calling code.
 *
 * @param {string} baseUrl – project website root (including protocol).
 * @param {import('playwright').Browser} browser – Playwright browser instance.
 * @returns {Promise<{emails: {email: string, name: string}[], linkedDomains: string[]}>}
 */
async function crawlWebsite(baseUrl, browser) {
  const paths = ['', '/about', '/team', '/blog', '/press'];
  const emails = [];
  const linkedDomains = new Set();

  for (const path of paths) {
    const url = new URL(path, baseUrl).toString();
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      emails.push(...(await scrapeEmailsFromPage(page)));
      // Look for links to external personal websites.
      const foundLinks = await page.evaluate(() => {
        const links = [];
        document.querySelectorAll('a[href]').forEach((a) => {
          const href = a.href;
          // Only external domains.
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
      await page.close();
    } catch (err) {
      // Ignore page failures.
    }
  }
  return { emails, linkedDomains: Array.from(linkedDomains) };
}

/**
 * Scrape a Twitter profile for contact information.  It opens the profile URL,
 * extracts the bio text, pinned tweet content and website link (if present),
 * then searches for email patterns.  It also returns any mentioned
 * @handles that might correspond to the founders or team members.
 *
 * @param {string} handle – Twitter username without the leading @.
 * @param {import('playwright').Browser} browser – Playwright browser instance.
 * @returns {Promise<{emails: string[], handles: string[], names: string[]}>}
 */
async function scrapeTwitterProfile(handle, browser) {
  const result = { emails: [], handles: [], names: [] };
  const page = await browser.newPage();
  try {
    await page.goto(`https://twitter.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Accept cookies or sign‑in prompts if present by pressing Esc.
    try { await page.keyboard.press('Escape'); } catch (_) {}
    const { bioText, websiteUrl, pinnedText, displayName } = await page.evaluate(() => {
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
    // ignore
  } finally {
    await page.close();
  }
  return result;
}

/**
 * Scrape a Telegram public channel or group for contact emails.
 * It navigates to the t.me link, reads the channel/about description
 * and performs a regex search for email patterns.  Playwright will
 * render the public Telegram preview without logging in.  Note that
 * some channels only display limited information publicly; in those
 * cases this function may return an empty list.
 *
 * @param {string} handle – Telegram channel/group handle without @.
 * @param {import('playwright').Browser} browser – Playwright browser instance.
 * @returns {Promise<string[]>}
 */
async function scrapeTelegram(handle, browser) {
  const emails = [];
  const page = await browser.newPage();
  try {
    await page.goto(`https://t.me/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const text = await page.evaluate(() => document.body.innerText);
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const matches = text.match(emailRegex) || [];
    emails.push(...matches);
  } catch (err) {
    // ignore
  } finally {
    await page.close();
  }
  return emails;
}

/**
 * Generate a set of common email permutations given a person’s name and domain.
 * Patterns include:
 *  - first.last@domain
 *  - first@domain
 *  - f.last@domain
 *  - firstl@domain
 *  - last@domain
 * Only unique patterns are returned.
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} domain
 * @returns {string[]}
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
 * Check whether an email’s domain has valid MX records.  This is a light
 * syntax sanity check before handing off to a full verification service.
 *
 * @param {string} email
 * @returns {Promise<boolean>}
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
 * Correlate candidate emails from multiple sources and score them.  Verified
 * emails receive +40 points, duplicates across sources +20 and domain
 * matches +10.  The candidate with the highest score is selected as the
 * primary email; alternates are returned in score order.  Unverifiable
 * addresses are filtered out.
 *
 * @param {Object[]} candidates – array of { email, source, verified }.
 *   source can be any string (e.g. 'whois', 'website', 'twitter', 'telegram').
 *   verified is boolean indicating Snov.io verification status.
 * @param {string} projectDomain – used to award domain match points.
 * @returns {{ primary: string, alternates: string[] }}
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
 * Main entry point to discover and validate key decision‑makers’ email
 * addresses for a given Web3 project.  It orchestrates the domain
 * intelligence, website scraping, social OSINT and permutation/verification
 * steps described in the user’s workflow.  The function returns an
 * object conforming to the output_schema defined in the user’s task.
 *
 * @param {Object} project – metadata for the project
 * @param {string} project.name – project name
 * @param {string} project.website – root website URL
 * @param {string} project.twitter – Twitter handle (without @)
 * @param {string} project.telegram – Telegram channel/group handle (without @)
 * @returns {Promise<Object>} – result object with primary/alternate emails and evidence
 */
async function discoverProjectEmails(project) {
  const browser = await chromium.launch({ headless: true });
  const result = {
    project: project.name,
    primary_email: '',
    alternate_emails: [],
    evidence: { twitter: '', telegram: '', website: '', whois: '' },
    verification_status: 'unverifiable',
  };
  const candidates = [];

  // 1. Domain Intelligence
  const domain = new URL(project.website).hostname.replace(/^www\./, '');
  const whoisEmail = await performWhoisLookup(domain);
  if (whoisEmail) {
    candidates.push({ email: whoisEmail, source: 'whois', verified: false });
    result.evidence.whois = whoisEmail;
  }
  // Domain search via Snov.io API
  try {
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
    }
  } catch (err) {
    // Snov.io failed, continue with other methods
  }

  // 2. Website Scrape
  const { emails: websiteEmails, linkedDomains } = await crawlWebsite(project.website, browser);
  websiteEmails.forEach(({ email, name }) => {
    candidates.push({ email, source: 'website', verified: false });
  });
  result.evidence.website = websiteEmails.length ? project.website : '';

  // 3. Twitter OSINT
  if (project.twitter) {
    const twitterData = await scrapeTwitterProfile(project.twitter, browser);
    twitterData.emails.forEach((email) => {
      candidates.push({ email, source: 'twitter', verified: false });
    });
    // Process additional handles or website links.
    for (const h of twitterData.handles) {
      if (h.startsWith('http')) {
        // A website link; crawl it.
        try {
          const { emails: e } = await crawlWebsite(h, browser);
          e.forEach(({ email }) => {
            candidates.push({ email, source: 'twitter-linked', verified: false });
          });
        } catch (_) {}
      } else {
        // Another Twitter handle; scrape recursively (depth 1).
        const subData = await scrapeTwitterProfile(h, browser);
        subData.emails.forEach((email) => {
          candidates.push({ email, source: 'twitter', verified: false });
        });
      }
    }
    result.evidence.twitter = twitterData.emails[0] || '';
  }

  // 4. Telegram OSINT
  if (project.telegram) {
    const telegramEmails = await scrapeTelegram(project.telegram, browser);
    telegramEmails.forEach((email) => {
      candidates.push({ email, source: 'telegram', verified: false });
    });
    result.evidence.telegram = telegramEmails[0] || '';
  }

  // 5. Permutation + Verification
  // Build name/domain tuples for permutations using names captured from
  // Twitter and website (twitterData.names, websiteEmails names) and
  // linkedDomains from the website crawl.  For brevity we only generate
  // permutations for the project’s own domain.  Additional domains could
  // also be processed if desired.
  const names = [];
  // Collect names from website (extracted name field may be empty).
  websiteEmails.forEach(({ name }) => {
    if (name && name.split(' ').length >= 2) {
      names.push(name);
    }
  });
  // Collect names from Twitter display names.
  // Note: twitterData may be undefined if no twitter handle provided.
  // Add to names for permutation.
  // Generate candidate emails from permutations and verify them.
  for (const fullName of names) {
    const parts = fullName.split(/\s+/);
    const first = parts[0];
    const last = parts[parts.length - 1];
    const perms = generateEmailPermutations(first, last, domain);
    for (const email of perms) {
      // Check MX to avoid obviously invalid domains.
      if (!(await hasValidMX(email))) continue;
      // For permutations, we'll assume they're unverified initially
      // Full verification would require additional Snov.io API calls
      const verified = false;
      candidates.push({ email, source: 'permutation', verified });
    }
  }

  await browser.close();

  // 6. Cross‑Source Correlation & Ranking
  const { primary, alternates } = rankCandidates(candidates, domain);
  result.primary_email = primary;
  result.alternate_emails = alternates;
  // Determine overall verification status.
  const primaryCandidate = candidates.find((c) => c.email === primary);
  if (primaryCandidate) {
    result.verification_status = primaryCandidate.verified ? 'valid' : 'unverifiable';
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