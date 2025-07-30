#!/usr/bin/env node

/**
 * Simple OSINT test that works without browser dependencies
 * Tests only Snov.io and WHOIS functionality
 */

require('dotenv').config();
const { enrichDomain } = require('./src/enrichment/snovio');
const axios = require('axios');

async function testWhoisAPI(domain) {
  console.log(`\n=== Testing WHOIS API for ${domain} ===`);
  try {
    const response = await axios.get(`https://api.whoisjson.com/v1/whois?domain=${domain}`, {
      timeout: 10000
    });
    
    if (response.data && response.data.raw) {
      const match = response.data.raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      const email = match ? match[0] : 'No email found';
      console.log(`✓ WHOIS found: ${email}`);
      return email;
    }
  } catch (error) {
    console.log(`✗ WHOIS API failed: ${error.message}`);
  }
  return '';
}

async function testSnovio(domain) {
  console.log(`\n=== Testing Snov.io API for ${domain} ===`);
  try {
    const result = await enrichDomain(domain);
    if (result && result.email) {
      console.log(`✓ Snov.io found: ${result.email}`);
      console.log(`  Name: ${result.firstName} ${result.lastName}`);
      console.log(`  Position: ${result.position}`);
      console.log(`  Status: ${result.emailStatus}`);
      return result;
    } else {
      console.log(`✗ Snov.io: No results for ${domain}`);
    }
  } catch (error) {
    console.log(`✗ Snov.io error: ${error.message}`);
  }
  return null;
}

async function testSimpleOSINT() {
  const testDomain = 'bitcoinhyper.com';
  
  console.log('=== Simple OSINT Test (No Browser Required) ===');
  console.log(`Testing domain: ${testDomain}`);
  
  // Test WHOIS
  const whoisEmail = await testWhoisAPI(testDomain);
  
  // Test Snov.io
  const snovioResult = await testSnovio(testDomain);
  
  // Summary
  console.log('\n=== SUMMARY ===');
  if (whoisEmail) {
    console.log(`WHOIS Email: ${whoisEmail}`);
  }
  if (snovioResult) {
    console.log(`Snov.io Email: ${snovioResult.email}`);
    console.log(`Contact: ${snovioResult.firstName} ${snovioResult.lastName} (${snovioResult.position})`);
  }
  
  if (!whoisEmail && !snovioResult) {
    console.log('No contacts found via API methods. Browser scraping would be needed for website/social discovery.');
  } else {
    console.log('✓ API-based contact discovery is working!');
  }
}

testSimpleOSINT();