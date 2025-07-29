const dotenv = require('dotenv');
dotenv.config();

const cron = require('node-cron');
const ingest = require('./ingest');

/**
 * Scheduler module.
 *
 * This module sets up cron jobs based on the cron expressions defined in
 * environment variables. Two schedules are defined by default: one for the
 * daily ingestion and one for the weekly ingestion. Both tasks run the
 * same pipeline; you may wish to customise them separately.
 */

function startScheduler() {
  const dailyCron = process.env.INGEST_CRON_DAILY || '0 2 * * *';
  const weeklyCron = process.env.INGEST_CRON_WEEKLY || '0 3 * * 1';
  console.log(`Scheduler started. Daily cron: ${dailyCron}, Weekly cron: ${weeklyCron}`);
  cron.schedule(dailyCron, () => {
    console.log('[Scheduler] Starting daily ingestion');
    ingest().catch((err) => {
      console.error('[Scheduler] Daily ingestion error:', err);
    });
  });
  cron.schedule(weeklyCron, () => {
    console.log('[Scheduler] Starting weekly ingestion');
    ingest().catch((err) => {
      console.error('[Scheduler] Weekly ingestion error:', err);
    });
  });
}

if (require.main === module) {
  startScheduler();
  // Keep the process alive
  console.log('Scheduler running...');
}

module.exports = startScheduler;