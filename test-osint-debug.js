#!/usr/bin/env node

/**
 * Debug script for OSINT email discovery module
 */

const { discoverProjectEmails } = require('./src/osint/emailDiscovery');
const { createLogger } = require('./src/utils/logger');

const logger = createLogger('OSINTDebug');

async function testOsintModule() {
  // Test with a sample lead from your data
  const testProject = {
    name: "Bitcoin Hyper",
    website: "https://bitcoinhyper.com/en",
    twitter: "BTC_Hyper2", // Already extracted handle
    telegram: "btchyperz"  // Already extracted handle
  };
  
  logger.info('Testing OSINT email discovery with sample project:');
  logger.info(JSON.stringify(testProject, null, 2));
  
  try {
    const result = await discoverProjectEmails(testProject);
    
    logger.info('OSINT Result:');
    logger.info(JSON.stringify(result, null, 2));
    
    if (result.primary_email) {
      logger.success(`✓ Found primary email: ${result.primary_email}`);
    } else {
      logger.warn('✗ No primary email found');
    }
    
    if (result.alternate_emails && result.alternate_emails.length > 0) {
      logger.info(`Found ${result.alternate_emails.length} alternate emails`);
    }
    
  } catch (error) {
    logger.error('OSINT module failed:', error);
    console.error(error.stack);
  }
}

testOsintModule();