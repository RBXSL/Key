// server.js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
app.use(express.json());
app.use(helmet());

// Config from env
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const KEY_SET = process.env.REDIS_KEYSET || 'unused_keys';
const CLAIM_TTL_SECONDS = parseInt(process.env.CLAIM_TTL || '600', 10); // 10 min default

// Init clients
const redis = createClient({ url: REDIS_URL });
redis.on('error', (e) => console.error('Redis error', e));
(async () => { await redis.connect(); })();

const pg = new Pool({ connectionString: DATABASE_URL });

// Rate limiter for claim endpoint
const claimLimiter = rateLimit({ windowMs: 60*1000, max: 30 });
app.use('/claim', claimLimiter);

// Utility
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// --- Admin: health ---
app.get('/_health', (req, res) => res.json({ ok: true }));

// --- Claim endpoint: called after Linkvertise redirect ---
app.get('/claim', async (req, res) => {
  try {
    // Optional: verify referer, token, or server-side webhook
    // For Linkvertise: ideally use server-to-server confirmation if available.
    // Atomically POP a random unused key from Redis
    const poppedKey = await redis.sPop(KEY_SET);
    if (!poppedKey) {
      return res.status(404).send('No keys available');
    }

    // create an issued one-time page record in Postgres
    const pageId = uuidv4();
    await pg.query(
      `INSERT INTO issued_pages(id, key_text, created_at, used) VALUES($1, $2, now(), false)`,
      [pageId, poppedKey]
    );

    // optionally set a TTL in Redis for this pageId to auto-expire if unused
    await redis.setEx(`page_ttl:${pageId}`, CLAIM_TTL_SECONDS, '1');

    // Redirect the user to the one-time page (id is not the key)
    return res.redirect(`/key/${pageId}`);
  } catch (err) {
    console.error('claim error', err);
    return res.status(500).send('Server error');
  }
});

// --- Serve the key once ---
app.get('/key/:pageId', async (req, res) => {
  const pageId = req.params.pageId;
  const clientIp = req.ip || req.connection.remoteAddress;
  const ua = req.get('User-Agent') || '';

  // Transaction: SELECT FOR UPDATE, check used, mark used
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query(
      'SELECT key_text, used FROM issued_pages WHERE id = $1 FOR UPDATE',
      [pageId]
    );

    if (q.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).send('Invalid or expired link');
    }

    const { key_text: keyText, used } = q.rows[0];
    if (used) {
      await client.query('ROLLBACK');
      return res.status(410).send('This key has already been claimed');
    }

    // mark used
    await client.query(
      'UPDATE issued_pages SET used = true, used_at = now(), ip = $2, user_agent = $3 WHERE id = $1',
      [pageId, clientIp, ua]
    );
    await client.query('COMMIT');

    // Delete TTL marker so page can't be used again (best effort)
    await redis.del(`page_ttl:${pageId}`);

    // Serve key in a non-cacheable way
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return res.send(`<html><head><meta name="robots" content="noindex"></head><body><h1>Your Key</h1><p style="font-family:monospace;font-size:18px;">${escapeHtml(keyText)}</p><p>Do not share this link — it is single-use.</p></body></html>`);
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('key serve error', err);
    return res.status(500).send('Server error');
  } finally {
    client.release();
  }
});


// --- Admin: seed Redis from keys table (protected with simple token) ---
app.post('/admin/seed-redis', async (req, res) => {
  const token = req.get('x-admin-token') || req.body?.token;
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send('unauthorized');

  try {
    const q = await pg.query('SELECT key_text FROM keys WHERE deprecated = false');
    if (q.rowCount === 0) return res.send('no keys in DB');

    // Add all keys into Redis set (idempotent)
    const pipeline = redis.multi();
    q.rows.forEach(r => pipeline.sAdd(KEY_SET, r.key_text));
    await pipeline.exec();
    return res.send(`seeded ${q.rowCount} keys to redis set ${KEY_SET}`);
  } catch (err) {
    console.error('seed redis error', err);
    return res.status(500).send('server error');
  }
});

// --- Admin: quick inspect (protected) ---
app.get('/admin/issued', async (req, res) => {
  const token = req.get('x-admin-token');
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).send('unauthorized');

  const q = await pg.query('SELECT id, key_text, used, created_at, used_at, ip FROM issued_pages ORDER BY created_at DESC LIMIT 200');
  return res.json(q.rows);
});

// start
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
