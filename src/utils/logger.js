/**
 * Enhanced logging utility with timestamps, progress indicators, and debug output
 * 
 * Provides structured logging for the web3 prospector system with:
 * - Colorized output for different log levels
 * - Timestamp formatting
 * - Progress tracking for scraping operations
 * - API call logging with request/response details
 * - Error reporting with stack traces
 */

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Text colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  
  // Background colors
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m'
};

/**
 * Get formatted timestamp
 */
function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Format log message with color and timestamp
 */
function formatMessage(level, source, message, color = colors.white) {
  const timestamp = colors.gray + getTimestamp() + colors.reset;
  const levelStr = colors.bright + `[${level.toUpperCase()}]` + colors.reset;
  const sourceStr = color + `[${source}]` + colors.reset;
  return `${timestamp} ${levelStr} ${sourceStr} ${message}`;
}

/**
 * Enhanced logger class with progress tracking
 */
class Logger {
  constructor(source) {
    this.source = source;
    this.startTime = Date.now();
    this.progressCounters = new Map();
  }

  /**
   * Log info message
   */
  info(message) {
    console.log(formatMessage('info', this.source, message, colors.blue));
  }

  /**
   * Log success message
   */
  success(message) {
    console.log(formatMessage('success', this.source, message, colors.green));
  }

  /**
   * Log warning message
   */
  warn(message) {
    console.log(formatMessage('warn', this.source, message, colors.yellow));
  }

  /**
   * Log error message with optional stack trace
   */
  error(message, error = null) {
    console.log(formatMessage('error', this.source, message, colors.red));
    if (error && error.stack) {
      console.log(colors.dim + error.stack + colors.reset);
    }
  }

  /**
   * Log debug message (only in debug mode)
   */
  debug(message) {
    if (process.env.DEBUG === 'true') {
      console.log(formatMessage('debug', this.source, message, colors.gray));
    }
  }

  /**
   * Start progress tracking for an operation
   */
  startProgress(operationId, total, description) {
    this.progressCounters.set(operationId, {
      current: 0,
      total,
      description,
      startTime: Date.now(),
      lastUpdate: Date.now()
    });
    this.info(`${colors.cyan}Starting: ${description} (0/${total})${colors.reset}`);
  }

  /**
   * Update progress for an operation
   */
  updateProgress(operationId, current = null, details = '') {
    const progress = this.progressCounters.get(operationId);
    if (!progress) return;

    if (current !== null) {
      progress.current = current;
    } else {
      progress.current++;
    }

    const now = Date.now();
    const elapsed = (now - progress.startTime) / 1000;
    const rate = progress.current / elapsed;
    const eta = progress.current > 0 ? Math.round((progress.total - progress.current) / rate) : 0;
    
    const percentage = ((progress.current / progress.total) * 100).toFixed(1);
    const progressBar = this.createProgressBar(progress.current, progress.total);
    
    const message = `${colors.cyan}${progress.description}${colors.reset} ${progressBar} ${colors.bright}${progress.current}/${progress.total}${colors.reset} (${percentage}%) ${colors.gray}ETA: ${eta}s${colors.reset}${details ? ' - ' + details : ''}`;
    
    // Only update every 500ms to avoid spam
    if (now - progress.lastUpdate > 500) {
      console.log(formatMessage('progress', this.source, message, colors.cyan));
      progress.lastUpdate = now;
    }
  }

  /**
   * Complete progress tracking
   */
  completeProgress(operationId, message = '') {
    const progress = this.progressCounters.get(operationId);
    if (!progress) return;

    const elapsed = (Date.now() - progress.startTime) / 1000;
    const rate = progress.total / elapsed;
    
    const completedMessage = `${colors.green}✓ Completed: ${progress.description}${colors.reset} ${colors.bright}${progress.total}${colors.reset} items in ${colors.bright}${elapsed.toFixed(1)}s${colors.reset} (${rate.toFixed(1)}/s)${message ? ' - ' + message : ''}`;
    
    console.log(formatMessage('complete', this.source, completedMessage, colors.green));
    this.progressCounters.delete(operationId);
  }

  /**
   * Create visual progress bar
   */
  createProgressBar(current, total, width = 20) {
    const progress = current / total;
    const filled = Math.round(progress * width);
    const empty = width - filled;
    
    const bar = colors.green + '█'.repeat(filled) + colors.dim + '░'.repeat(empty) + colors.reset;
    return `[${bar}]`;
  }

  /**
   * Log API call details
   */
  logApiCall(method, url, status = null, responseTime = null) {
    const parts = [
      colors.magenta + method.toUpperCase() + colors.reset,
      url
    ];
    
    if (status) {
      const statusColor = status >= 200 && status < 300 ? colors.green : colors.red;
      parts.push(`${statusColor}${status}${colors.reset}`);
    }
    
    if (responseTime) {
      parts.push(`${colors.gray}${responseTime}ms${colors.reset}`);
    }
    
    this.debug(`API: ${parts.join(' ')}`);
  }

  /**
   * Log proxy rotation
   */
  logProxyRotation(proxyUrl, isWorking = true) {
    const status = isWorking ? colors.green + '✓' : colors.red + '✗';
    this.debug(`Proxy: ${status} ${proxyUrl}${colors.reset}`);
  }

  /**
   * Log scraping statistics
   */
  logStats(stats) {
    const {
      found = 0,
      processed = 0,
      filtered = 0,
      errors = 0,
      enriched = 0,
      duration = 0
    } = stats;

    console.log('');
    console.log(formatMessage('stats', this.source, `${colors.bright}=== SCRAPING STATISTICS ===${colors.reset}`, colors.cyan));
    console.log(formatMessage('stats', this.source, `Found: ${colors.bright}${found}${colors.reset} projects`, colors.cyan));
    console.log(formatMessage('stats', this.source, `Processed: ${colors.bright}${processed}${colors.reset} projects`, colors.cyan));
    console.log(formatMessage('stats', this.source, `Filtered out: ${colors.bright}${filtered}${colors.reset} projects`, colors.cyan));
    console.log(formatMessage('stats', this.source, `Errors: ${colors.bright}${errors}${colors.reset} projects`, colors.cyan));
    console.log(formatMessage('stats', this.source, `Enriched: ${colors.bright}${enriched}${colors.reset} projects`, colors.cyan));
    console.log(formatMessage('stats', this.source, `Duration: ${colors.bright}${(duration / 1000).toFixed(1)}s${colors.reset}`, colors.cyan));
    console.log('');
  }

  /**
   * Get runtime statistics
   */
  getRuntime() {
    return Date.now() - this.startTime;
  }
}

/**
 * Create a new logger instance
 */
function createLogger(source) {
  return new Logger(source);
}

module.exports = {
  createLogger,
  Logger,
  colors
};