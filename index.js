const https = require('node:https');
const { Pool } = require('pg');

// Use environment variables for DB credentials
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT ? parseInt(process.env.PGPORT) : 5432,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 10,
  ssl: { rejectUnauthorized: false },
});

/**
 * Fetch the last sync timestamp from Postgres for a given name.
 */
async function fetchLastSync(name) {
  const res = await pool.query(
    'SELECT last_sync FROM sync_status WHERE name = $1',
    [name]
  );
  if (res.rows.length > 0) {
    return res.rows[0].last_sync;
  }
  return null;
}

/**
 * Make an HTTPS GET request and resolve with parsed JSON.
 */
function fetchJson(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Lambda handler: retrieves the last sync timestamp, queries YouTube API for new playlist items,
 * and returns any items published after that timestamp.
 */
module.exports.handler = async (event, context) => {
  const apiKey = process.env.API_KEY || event.apiKey;
  const playlistId = event.playlistId;
  const name = event.name || 'youtube_obsidian';

  if (!apiKey || !playlistId) {
    throw new Error('Missing required parameters: apiKey and playlistId');
  }

  try {
    // Determine timestamp to use
    const dbTimestamp = await fetchLastSync(name);
    const lastChecked = event.lastChecked || dbTimestamp;

    // Build YouTube API request
    const queryParams = new URLSearchParams({
      part: 'snippet',
      maxResults: '50',
      playlistId,
      key: apiKey,
    });
    const options = {
      hostname: 'www.googleapis.com',
      path: `/youtube/v3/playlistItems?${queryParams.toString()}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
    };

    // Fetch and filter
    const data = await fetchJson(options);
    let items = data.items || [];
    if (lastChecked) {
      const lastTime = new Date(lastChecked).getTime();
      items = items.filter((item) => {
        const pub = new Date(item.snippet.publishedAt).getTime();
        return pub > lastTime;
      });
    }

    // Extract all snippets from filtered items
    const snippets = items.map(item => item.snippet);

    // If there are snippets, send the payload to the specified API endpoint
    if (snippets.length > 0) {
      const postData = JSON.stringify({ snippets });

      const postOptions = {
        hostname: 'n8n.cafesean.com',
        path: '/webhook/44ca4ee2-1788-4963-997b-c0b5d19b42fd',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      await new Promise((resolve, reject) => {
        const req = https.request(postOptions, (res) => {
          res.on('data', () => {}); // consume response data to free up memory
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
      });
    }

    return { snippets };
  } catch (err) {
    console.error('Error in handler:', err);
    throw err;
  }
};
