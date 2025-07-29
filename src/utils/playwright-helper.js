/**
 * Playwright Helper Utility
 * 
 * Provides robust browser automation utilities with:
 * - Exponential backoff retry logic
 * - Selector fallback strategies
 * - Stealth mode for anti-bot protection
 * - Comprehensive error handling
 * - Browser instance management
 */

const { chromium } = require('playwright');
const { addExtra } = require('playwright-extra');
const { createLogger } = require('./logger');
const selectors = require('../config/selectors.json');

// Add stealth plugin if available
let playwrightExtra;
try {
  const StealthPlugin = require('playwright-extra-plugin-stealth');
  playwrightExtra = addExtra(chromium);
  playwrightExtra.use(StealthPlugin());
} catch (error) {
  // Fallback to regular chromium if stealth plugin not available
  playwrightExtra = chromium;
}

class PlaywrightHelper {
  constructor(options = {}) {
    this.logger = createLogger('PlaywrightHelper');
    this.options = {
      headless: true,
      timeout: 30000,
      retries: 3,
      retryDelay: 1000,
      ...options
    };
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /**
   * Initialize browser with stealth mode and proxy support
   */
  async initialize(proxyConfig = null) {
    try {
      this.logger.info('Initializing Playwright browser with stealth mode');
      
      const browserOptions = {
        headless: this.options.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor'
        ]
      };

      if (proxyConfig) {
        browserOptions.proxy = {
          server: `http://${proxyConfig.host}:${proxyConfig.port}`,
          username: proxyConfig.username,
          password: proxyConfig.password
        };
        this.logger.info(`Using proxy: ${proxyConfig.host}:${proxyConfig.port}`);
      }

      this.browser = await playwrightExtra.launch(browserOptions);
      
      this.context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York'
      });

      this.page = await this.context.newPage();
      
      // Set reasonable timeouts
      this.page.setDefaultTimeout(this.options.timeout);
      this.page.setDefaultNavigationTimeout(this.options.timeout);

      this.logger.success('Playwright browser initialized successfully');
      return this.page;
      
    } catch (error) {
      this.logger.error('Failed to initialize browser:', error);
      throw error;
    }
  }

  /**
   * Navigate to URL with retry logic
   */
  async navigateTo(url, options = {}) {
    const maxRetries = options.retries || this.options.retries;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.debug(`Navigating to ${url} (attempt ${attempt}/${maxRetries})`);
        
        await this.page.goto(url, {
          waitUntil: 'networkidle',
          timeout: this.options.timeout,
          ...options
        });

        this.logger.success(`Successfully navigated to ${url}`);
        return;
        
      } catch (error) {
        lastError = error;
        this.logger.warn(`Navigation attempt ${attempt} failed: ${error.message}`);
        
        if (attempt < maxRetries) {
          const delay = this.options.retryDelay * Math.pow(2, attempt - 1);
          this.logger.info(`Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    throw new Error(`Failed to navigate to ${url} after ${maxRetries} attempts: ${lastError.message}`);
  }

  /**
   * Wait for element with fallback selectors
   */
  async waitForElement(selectorArray, options = {}) {
    if (typeof selectorArray === 'string') {
      selectorArray = [selectorArray];
    }

    const timeout = options.timeout || this.options.timeout;
    const startTime = Date.now();

    for (const selector of selectorArray) {
      try {
        const remainingTime = timeout - (Date.now() - startTime);
        if (remainingTime <= 0) break;

        this.logger.debug(`Trying selector: ${selector}`);
        await this.page.waitForSelector(selector, { 
          timeout: Math.min(remainingTime, 5000),
          ...options 
        });
        
        this.logger.debug(`Element found with selector: ${selector}`);
        return selector;
        
      } catch (error) {
        this.logger.debug(`Selector failed: ${selector} - ${error.message}`);
        continue;
      }
    }

    throw new Error(`None of the selectors found an element: ${selectorArray.join(', ')}`);
  }

  /**
   * Get elements with fallback selectors
   */
  async getElements(selectorArray, options = {}) {
    if (typeof selectorArray === 'string') {
      selectorArray = [selectorArray];
    }

    for (const selector of selectorArray) {
      try {
        const elements = await this.page.$$(selector);
        if (elements.length > 0) {
          this.logger.debug(`Found ${elements.length} elements with selector: ${selector}`);
          return elements;
        }
      } catch (error) {
        this.logger.debug(`Selector failed: ${selector} - ${error.message}`);
        continue;
      }
    }

    this.logger.warn(`No elements found with any selector: ${selectorArray.join(', ')}`);
    return [];
  }

  /**
   * Get single element with fallback selectors
   */
  async getElement(selectorArray, options = {}) {
    if (typeof selectorArray === 'string') {
      selectorArray = [selectorArray];
    }

    for (const selector of selectorArray) {
      try {
        const element = await this.page.$(selector);
        if (element) {
          this.logger.debug(`Element found with selector: ${selector}`);
          return element;
        }
      } catch (error) {
        this.logger.debug(`Selector failed: ${selector} - ${error.message}`);
        continue;
      }
    }

    return null;
  }

  /**
   * Extract text with fallback selectors
   */
  async extractText(selectorArray, defaultValue = null) {
    const element = await this.getElement(selectorArray);
    if (element) {
      try {
        const text = await element.textContent();
        return text ? text.trim() : defaultValue;
      } catch (error) {
        this.logger.debug(`Failed to extract text: ${error.message}`);
      }
    }
    return defaultValue;
  }

  /**
   * Extract attribute with fallback selectors
   */
  async extractAttribute(selectorArray, attribute, defaultValue = null) {
    const element = await this.getElement(selectorArray);
    if (element) {
      try {
        const value = await element.getAttribute(attribute);
        return value || defaultValue;
      } catch (error) {
        this.logger.debug(`Failed to extract attribute ${attribute}: ${error.message}`);
      }
    }
    return defaultValue;
  }

  /**
   * Extract all links matching social media patterns
   */
  async extractSocialLinks(containerSelector = 'body') {
    try {
      const links = await this.page.evaluate((selector) => {
        const container = document.querySelector(selector) || document.body;
        const linkElements = container.querySelectorAll('a[href]');
        const socialLinks = {};

        linkElements.forEach(link => {
          const href = link.href.toLowerCase();
          const text = (link.textContent || link.title || '').toLowerCase();

          if (href.includes('twitter.com') || href.includes('x.com')) {
            socialLinks.twitter = link.href;
          } else if (href.includes('t.me') || href.includes('telegram')) {
            socialLinks.telegram = link.href;
          } else if (href.includes('discord')) {
            socialLinks.discord = link.href;
          } else if (href.includes('github')) {
            socialLinks.github = link.href;
          } else if (href.includes('linkedin')) {
            socialLinks.linkedin = link.href;
          } else if (href.includes('medium.com')) {
            socialLinks.medium = link.href;
          } else if (href.includes('youtube')) {
            socialLinks.youtube = link.href;
          } else if (text.includes('website') || text.includes('visit')) {
            if (!socialLinks.website) {
              socialLinks.website = link.href;
            }
          }
        });

        return socialLinks;
      }, containerSelector);

      return links;
    } catch (error) {
      this.logger.debug(`Failed to extract social links: ${error.message}`);
      return {};
    }
  }

  /**
   * Handle infinite scroll loading
   */
  async handleInfiniteScroll(maxScrolls = 5, scrollDelay = 2000) {
    let scrollCount = 0;
    let previousHeight = 0;

    while (scrollCount < maxScrolls) {
      const currentHeight = await this.page.evaluate(() => document.body.scrollHeight);
      
      if (currentHeight === previousHeight) {
        this.logger.debug('No new content loaded, stopping scroll');
        break;
      }

      this.logger.debug(`Scrolling (${scrollCount + 1}/${maxScrolls})`);
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await this.sleep(scrollDelay);

      previousHeight = currentHeight;
      scrollCount++;
    }

    this.logger.debug(`Completed ${scrollCount} scrolls`);
  }

  /**
   * Handle pagination
   */
  async handlePagination(nextButtonSelector, maxPages = 10) {
    let pageCount = 1;
    const results = [];

    while (pageCount <= maxPages) {
      this.logger.debug(`Processing page ${pageCount}`);
      
      // Process current page (implement in specific scraper)
      // This is a template method
      
      try {
        const nextButton = await this.getElement(nextButtonSelector);
        if (!nextButton) {
          this.logger.debug('No next button found, pagination complete');
          break;
        }

        const isDisabled = await nextButton.getAttribute('disabled');
        if (isDisabled) {
          this.logger.debug('Next button is disabled, pagination complete');
          break;
        }

        await nextButton.click();
        await this.sleep(2000);
        pageCount++;
        
      } catch (error) {
        this.logger.debug(`Pagination failed on page ${pageCount}: ${error.message}`);
        break;
      }
    }

    return results;
  }

  /**
   * Sleep utility
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Screenshot for debugging
   */
  async screenshot(filename) {
    try {
      await this.page.screenshot({ path: filename, fullPage: true });
      this.logger.debug(`Screenshot saved: ${filename}`);
    } catch (error) {
      this.logger.debug(`Failed to take screenshot: ${error.message}`);
    }
  }

  /**
   * Get selectors for a specific source
   */
  getSelectors(source) {
    return selectors[source] || {};
  }

  /**
   * Clean up browser resources
   */
  async cleanup() {
    try {
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      if (this.context) {
        await this.context.close();
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      this.logger.debug('Browser cleanup completed');
    } catch (error) {
      this.logger.error('Error during cleanup:', error);
    }
  }
}

module.exports = { PlaywrightHelper };