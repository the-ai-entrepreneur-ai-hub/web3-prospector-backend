/**
 * Proxy rotation utility for web scraping
 * 
 * Provides rotating proxy support using the DataImpulse proxy service.
 * Features:
 * - Automatic proxy rotation
 * - Health checking and failover
 * - Connection pooling
 * - Request logging and monitoring
 */

const { createLogger } = require('./logger');

class ProxyRotator {
  constructor(proxyConfig) {
    this.logger = createLogger('ProxyRotator');
    this.config = proxyConfig;
    this.currentProxyIndex = 0;
    this.proxies = this.parseProxyConfig(proxyConfig);
    this.proxyStats = new Map();
    this.maxRetries = 3;
    
    // Initialize stats for each proxy
    this.proxies.forEach((proxy, index) => {
      this.proxyStats.set(index, {
        requests: 0,
        errors: 0,
        lastUsed: 0,
        isHealthy: true,
        responseTime: 0
      });
    });

    this.logger.info(`Initialized with ${this.proxies.length} proxy endpoints`);
  }

  /**
   * Parse proxy configuration into usable format
   */
  parseProxyConfig(config) {
    // For DataImpulse rotating proxy, we create multiple endpoint variations
    // to distribute load across different sessions
    const baseProxy = {
      host: 'gw.dataimpulse.com',
      port: 823,
      username: '8c099c72ca71b14edcc0',
      password: 'b6ed4ad954817a1e'
    };

    // Create multiple session endpoints for better distribution
    const proxies = [];
    for (let i = 1; i <= 5; i++) {
      proxies.push({
        ...baseProxy,
        // Add session ID to username for sticky sessions
        username: `${baseProxy.username}-session${i}`,
        id: `dataimpulse-session${i}`
      });
    }

    return proxies;
  }

  /**
   * Get the next available proxy
   */
  getNextProxy() {
    let attempts = 0;
    const maxAttempts = this.proxies.length * 2;

    while (attempts < maxAttempts) {
      const proxyIndex = this.currentProxyIndex;
      const proxy = this.proxies[proxyIndex];
      const stats = this.proxyStats.get(proxyIndex);

      // Move to next proxy for round-robin
      this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxies.length;
      attempts++;

      // Check if proxy is healthy and not overused
      const timeSinceLastUse = Date.now() - stats.lastUsed;
      const isRecentlyUsed = timeSinceLastUse < 1000; // Less than 1 second

      if (stats.isHealthy && !isRecentlyUsed) {
        stats.lastUsed = Date.now();
        stats.requests++;
        
        this.logger.debug(`Selected proxy: ${proxy.id} (${stats.requests} requests, ${stats.errors} errors)`);
        return {
          proxy,
          index: proxyIndex
        };
      }
    }

    // If no healthy proxy found, return the least used one
    const leastUsedIndex = Array.from(this.proxyStats.entries())
      .sort(([, a], [, b]) => a.requests - b.requests)[0][0];
    
    const proxy = this.proxies[leastUsedIndex];
    const stats = this.proxyStats.get(leastUsedIndex);
    
    stats.lastUsed = Date.now();
    stats.requests++;
    
    this.logger.warn(`Using fallback proxy: ${proxy.id} (all proxies heavily used)`);
    return {
      proxy,
      index: leastUsedIndex
    };
  }

  /**
   * Mark a proxy as failed
   */
  markProxyFailed(proxyIndex, error) {
    const stats = this.proxyStats.get(proxyIndex);
    const proxy = this.proxies[proxyIndex];
    
    if (stats) {
      stats.errors++;
      
      // Mark as unhealthy if too many errors
      if (stats.errors > 5) {
        stats.isHealthy = false;
        this.logger.error(`Proxy ${proxy.id} marked as unhealthy after ${stats.errors} errors`);
      }
      
      this.logger.logProxyRotation(`${proxy.id}: ${error.message}`, false);
    }
  }

  /**
   * Mark a proxy as successful
   */
  markProxySuccess(proxyIndex, responseTime) {
    const stats = this.proxyStats.get(proxyIndex);
    const proxy = this.proxies[proxyIndex];
    
    if (stats) {
      stats.responseTime = responseTime;
      
      // Reset health status if it was marked unhealthy
      if (!stats.isHealthy) {
        stats.isHealthy = true;
        this.logger.success(`Proxy ${proxy.id} restored to healthy status`);
      }
      
      this.logger.logProxyRotation(`${proxy.id}: ${responseTime}ms`, true);
    }
  }

  /**
   * Get Puppeteer proxy configuration
   */
  getPuppeteerProxyConfig(proxyData) {
    const { proxy } = proxyData;
    return {
      server: `http://${proxy.host}:${proxy.port}`,
      username: proxy.username,
      password: proxy.password
    };
  }

  /**
   * Get axios proxy configuration
   */
  getAxiosProxyConfig(proxyData) {
    const { proxy } = proxyData;
    return {
      host: proxy.host,
      port: proxy.port,
      auth: {
        username: proxy.username,
        password: proxy.password
      },
      protocol: 'http'
    };
  }

  /**
   * Create a Puppeteer browser with proxy
   */
  async createBrowserWithProxy(puppeteer, additionalArgs = []) {
    const proxyData = this.getNextProxy();
    const proxyConfig = this.getPuppeteerProxyConfig(proxyData);
    
    this.logger.debug(`Creating browser with proxy: ${proxyData.proxy.id}`);
    
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        `--proxy-server=${proxyConfig.server}`,
        ...additionalArgs
      ]
    });

    // Authenticate proxy on first page
    const page = await browser.newPage();
    await page.authenticate({
      username: proxyConfig.username,
      password: proxyConfig.password
    });
    
    // Store proxy info for error tracking
    page._proxyData = proxyData;
    browser._proxyData = proxyData;
    
    return { browser, page, proxyData };
  }

  /**
   * Create axios instance with proxy
   */
  createAxiosWithProxy() {
    const proxyData = this.getNextProxy();
    const axios = require('axios');
    
    const instance = axios.create({
      proxy: this.getAxiosProxyConfig(proxyData),
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    // Add request/response interceptors for logging
    instance.interceptors.request.use(
      (config) => {
        config._requestStart = Date.now();
        this.logger.logApiCall(config.method?.toUpperCase() || 'GET', config.url);
        return config;
      },
      (error) => {
        this.markProxyFailed(proxyData.index, error);
        return Promise.reject(error);
      }
    );
    
    instance.interceptors.response.use(
      (response) => {
        const responseTime = Date.now() - response.config._requestStart;
        this.markProxySuccess(proxyData.index, responseTime);
        this.logger.logApiCall(
          response.config.method?.toUpperCase() || 'GET',
          response.config.url,
          response.status,
          responseTime
        );
        return response;
      },
      (error) => {
        this.markProxyFailed(proxyData.index, error);
        const responseTime = Date.now() - (error.config?._requestStart || Date.now());
        this.logger.logApiCall(
          error.config?.method?.toUpperCase() || 'GET',
          error.config?.url || 'unknown',
          error.response?.status || 0,
          responseTime
        );
        return Promise.reject(error);
      }
    );
    
    instance._proxyData = proxyData;
    return instance;
  }

  /**
   * Get proxy statistics
   */
  getStats() {
    const stats = Array.from(this.proxyStats.entries()).map(([index, data]) => ({
      proxy: this.proxies[index].id,
      requests: data.requests,
      errors: data.errors,
      errorRate: data.requests > 0 ? (data.errors / data.requests * 100).toFixed(1) : '0.0',
      isHealthy: data.isHealthy,
      avgResponseTime: data.responseTime
    }));

    return {
      totalProxies: this.proxies.length,
      healthyProxies: stats.filter(s => s.isHealthy).length,
      totalRequests: stats.reduce((sum, s) => sum + s.requests, 0),
      totalErrors: stats.reduce((sum, s) => sum + s.errors, 0),
      proxies: stats
    };
  }

  /**
   * Log current proxy statistics
   */
  logStats() {
    const stats = this.getStats();
    
    this.logger.info(`=== PROXY STATISTICS ===`);
    this.logger.info(`Total Proxies: ${stats.totalProxies} (${stats.healthyProxies} healthy)`);
    this.logger.info(`Total Requests: ${stats.totalRequests}`);
    this.logger.info(`Total Errors: ${stats.totalErrors}`);
    this.logger.info(`Overall Error Rate: ${stats.totalRequests > 0 ? (stats.totalErrors / stats.totalRequests * 100).toFixed(1) : '0.0'}%`);
    
    stats.proxies.forEach(proxy => {
      const status = proxy.isHealthy ? '✓' : '✗';
      this.logger.info(`  ${status} ${proxy.proxy}: ${proxy.requests} req, ${proxy.errors} err (${proxy.errorRate}%), ${proxy.avgResponseTime}ms avg`);
    });
  }
}

/**
 * Create a proxy rotator instance
 */
function createProxyRotator() {
  // Use environment variable or default DataImpulse config
  const proxyConfig = {
    host: process.env.PROXY_HOST || 'gw.dataimpulse.com',
    port: parseInt(process.env.PROXY_PORT) || 823,
    username: process.env.PROXY_USERNAME || '8c099c72ca71b14edcc0',
    password: process.env.PROXY_PASSWORD || 'b6ed4ad954817a1e'
  };
  
  return new ProxyRotator(proxyConfig);
}

module.exports = {
  ProxyRotator,
  createProxyRotator
};