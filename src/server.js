const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const ingest = require('./ingest');
const { filterLeads } = require('./utils/filters');
const { findRecordByDomain } = require('./services/airtable');

/**
 * Express server exposing simple endpoints to trigger ingestion and query data.
 *
 * Routes:
 *  POST /api/v1/leads/start-ingestion
 *    Triggers a single run of the ingestion pipeline. Responds immediately
 *    after starting the job. The actual work is run asynchronously.
 *
 *  GET /api/v1/leads/:domain
 *    Retrieves a single lead by domain from Airtable.
 *
 *  GET /api/v1/health
 *    Returns basic health information.
 */

function createServer() {
  const app = express();
  app.use(express.json());

  // Trigger ingestion
  app.post('/api/v1/leads/start-ingestion', async (req, res) => {
    // Start ingestion asynchronously; don't await to keep the endpoint fast
    ingest().catch((err) => {
      console.error('Ingestion error:', err);
    });
    res.json({ status: 'started' });
  });

  // Fetch a lead by domain
  app.get('/api/v1/leads/:domain', async (req, res) => {
    const { domain } = req.params;
    try {
      const record = await findRecordByDomain(domain);
      if (!record) {
        return res.status(404).json({ error: 'Lead not found' });
      }
      res.json({ id: record.id, fields: record.fields });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Health check
  app.get('/api/v1/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  return app;
}

// Only start the server if this module is run directly
if (require.main === module) {
  const app = createServer();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

module.exports = createServer;