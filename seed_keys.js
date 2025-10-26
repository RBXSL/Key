// seed_keys.js — adds keys to keys table from an array (or file)
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    // Example: read a newline-separated file `initial_keys.txt`
    const raw = fs.readFileSync('./initial_keys.txt', 'utf8');
    const keys = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const k of keys) {
      try { await client.query('INSERT INTO keys(key_text) VALUES($1) ON CONFLICT DO NOTHING', [k]); }
      catch(err) { console.error('insert-err', k, err); }
    }
    console.log('seeded keys into DB:', keys.length);
  } finally {
    client.release();
    pool.end();
  }
})();
