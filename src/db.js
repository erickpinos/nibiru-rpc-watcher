const { Pool } = require("pg");
const { DATABASE_URL } = require("./config");

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.on("error", (err) => console.error("Unexpected pool error:", err.message));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rpc_health_logs (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      block_height BIGINT,
      response_time_ms INT,
      status_code INT,
      is_healthy BOOLEAN NOT NULL,
      error TEXT,
      uptime_24h NUMERIC(5,2)
    )
  `);
  await pool.query(`
    ALTER TABLE rpc_health_logs
    ADD COLUMN IF NOT EXISTS uptime_24h NUMERIC(5,2)
  `);
  console.log("Database table ready");
}

async function getUptime24h() {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_healthy) AS healthy,
        COUNT(*) AS total
      FROM rpc_health_logs
      WHERE timestamp > NOW() - INTERVAL '24 hours'
    `);
    const { healthy, total } = rows[0];
    if (parseInt(total) === 0) return null;
    return parseFloat(((parseInt(healthy) / parseInt(total)) * 100).toFixed(2));
  } catch (err) {
    console.error("getUptime24h query failed:", err.message);
    return null;
  }
}

async function insertHealthLog(blockHeight, responseTime, statusCode, isHealthy, error) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO rpc_health_logs (block_height, response_time_ms, status_code, is_healthy, error)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [blockHeight, responseTime, statusCode, isHealthy, error]
    );
    return rows[0].id;
  } catch (dbErr) {
    console.error("DB write failed:", dbErr.message);
    return null;
  }
}

async function updateUptime(id, uptime) {
  try {
    await pool.query(
      `UPDATE rpc_health_logs SET uptime_24h = $1 WHERE id = $2`,
      [uptime, id]
    );
  } catch (dbErr) {
    console.error("DB uptime update failed:", dbErr.message);
  }
}

module.exports = { pool, initDb, getUptime24h, insertHealthLog, updateUptime };
