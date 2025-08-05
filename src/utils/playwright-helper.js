const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { createLogger } = require('./logger');

// Apply the stealth plugin to chromium, which makes it harder to detect
chromium.use(stealth);

class PlaywrightHelper {
  constructor(options = {}) {
    this.options = {
      browserType: 'chromium', // We will use the stealth-enabled chromium
      headless: true,
      timeout: 90000, // Increased default timeout for challenges
      retries: 2,
      ...options,
    };
    this.playwright = { chromium }; 
    this.browser = null;
    this.context = null;
    this.page = null;
    this.logger = createLogger('PlaywrightHelper');
  }

  async initialize(proxyConfig = {}) {
    this.logger.info(`Initializing Playwright browser with ADVANCED stealth mode`);
    if (proxyConfig && proxyConfig.host) {
      this.logger.info(`Using proxy: ${proxyConfig.host}:${proxyConfig.port}`);
    }

    const launchOptions = {
        headless: this.options.headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
        ]
    };

    if (proxyConfig && proxyConfig.host) {
        launchOptions.proxy = {
            server: `${proxyConfig.host}:${proxyConfig.port}`,
            username: proxyConfig.username,
            password: proxyConfig.password,
        };
    }

    try {
      this.browser = await this.playwright[this.options.browserType].launch(launchOptions);
      this.context = await this.browser.newContext({
          ignoreHTTPSErrors: true, // Necessary for some proxy services
          viewport: { width: 1920, height: 1080 },
          // The stealth plugin handles the user agent, but we can set a modern one as a fallback.
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      });
      this.page = await this.context.newPage();
      this.logger.success('Playwright browser initialized successfully');
    } catch (error) {
      this.logger.error(`Failed to initialize Playwright: ${error.message}`);
      throw error;
    }
  }

  async navigateTo(url, options = {}) {
    const { retries, timeout } = this.options;
    for (let i = 0; i < retries; i++) {
      try {
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout, ...options });
        this.logger.success(`Successfully navigated to ${url}`);
        return;
      } catch (error) {
        this.logger.warn(`Attempt ${i + 1}/${retries} failed to navigate to ${url}: ${error.message}`);
        if (i === retries - 1) {
          this.logger.error(`All attempts to navigate to ${url} failed.`);
          throw error;
        }
      }
    }
  }

  async waitForElement(selectors, options = {}) {
    if (!Array.isArray(selectors)) selectors = [selectors];
    const { timeout = this.options.timeout } = options;
    const selectorString = selectors.join(', ');
    try {
        await this.page.waitForSelector(selectorString, { state: 'visible', timeout });
    } catch (error) {
      throw new Error(`Timeout waiting for element: ${selectorString}`);
    }
  }
  
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  async screenshot(path) {
    try {
      if(this.page && !this.page.isClosed()) {
        await this.page.screenshot({ path, fullPage: true });
        this.logger.info(`Screenshot saved to ${path}`);
      }
    } catch (error) {
      this.logger.error(`Failed to take screenshot: ${error}`);
    }
  }

  async cleanup() {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        this.logger.error(`Error during Playwright cleanup: ${error.message}`);
      }
    }
  }
}

module.exports = { PlaywrightHelper };