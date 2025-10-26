// migrate.js — runs schema migrations quickly
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS keys (
        id SERIAL PRIMARY KEY,
        key_text TEXT NOT NULL UNIQUE,
        deprecated BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS issued_pages (
        id UUID PRIMARY KEY,
        key_text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT now(),
        used BOOLEAN DEFAULT false,
        used_at TIMESTAMP NULL,
        ip TEXT NULL,
        user_agent TEXT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_issued_used ON issued_pages(used);
    `);
    console.log('migrations applied');
  } catch (e) {
    console.error('migrate error', e);
  } finally {
    client.release();
    pool.end();
  }
})();
