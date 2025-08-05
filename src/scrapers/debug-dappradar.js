const fs = require('fs');
const path = require('path');
// Use playwright-extra and the stealth plugin
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const { createLogger } = require('../utils/logger');
const logger = createLogger('DappRadar-DEBUG');

async function debugDappRadar() {
    logger.info('--- STARTING FINAL DAPPRADAR DEBUG SCRIPT ---');
    
    let browser;
    try {
        logger.info('Launching browser with ULTIMATE stealth and verbose logging...');
        
        browser = await chromium.launch({
            headless: false, // WATCH THIS WINDOW
            // Enable verbose logging from Playwright itself
            env: {
                ...process.env,
                "DEBUG": "pw:api",
            }
        });

        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        });
        
        const page = await context.newPage();

        const url = 'https://dappradar.com/rankings/category/defi';
        logger.info(`Navigating to: ${url}`);
        
        // Go to the page and wait for it to settle
        await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 }); // 2-minute timeout
        
        logger.success('Navigation command completed without timeout.');
        logger.info('Page has loaded. Waiting 10 seconds for observation...');
        await new Promise(resolve => setTimeout(resolve, 10000));

        logger.info('Capturing final page state...');
        
    } catch (error) {
        logger.error(`An error occurred during the debug run: ${error.message}`);
    } finally {
        if (browser) {
            const pages = browser.contexts()[0]?.pages();
            if (pages && pages.length > 0) {
                const page = pages[0];
                const screenshotPath = path.join(__dirname, '..', '..', 'DEBUG_DAPPRADAR_SCREENSHOT.png');
                await page.screenshot({ path: screenshotPath, fullPage: true });
                logger.success(`Screenshot saved to: ${screenshotPath}`);

                const htmlContent = await page.content();
                const htmlPath = path.join(__dirname, '..', '..', 'DEBUG_DAPPRADAR_PAGE.html');
                fs.writeFileSync(htmlPath, htmlContent);
                logger.success(`HTML content saved to: ${htmlPath}`);
            }
            await browser.close();
        }
        logger.info('--- DEBUG SCRIPT FINISHED ---');
    }
}

debugDappRadar();