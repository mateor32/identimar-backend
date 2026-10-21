require('dotenv').config();
const { Pool } = require('pg');

// Pool de conexiones a PostgreSQL (Supabase).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

const query = (text, params) => pool.query(text, params);

/**
 * Ejecuta `fn(client)` dentro de una transacción.
 * Hace COMMIT si termina bien y ROLLBACK si lanza un error.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
