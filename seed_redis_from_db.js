// seed_redis_from_db.js
require('dotenv').config();
const { Pool } = require('pg');
const { createClient } = require('redis');

(async () => {
  const pg = new Pool({ connectionString: process.env.DATABASE_URL });
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  const r = await pg.query('SELECT key_text FROM keys WHERE deprecated = false');
  if (r.rowCount === 0) {
    console.log('no keys found in DB');
    process.exit(0);
  }
  const multi = redis.multi();
  r.rows.forEach(row => multi.sAdd(process.env.REDIS_KEYSET || 'unused_keys', row.key_text));
  await multi.exec();
  console.log('seeded', r.rowCount, 'keys into redis set');
  await redis.quit();
  await pg.end();
})();
