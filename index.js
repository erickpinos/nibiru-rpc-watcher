const fetch = require("node-fetch");
const { Pool } = require("pg");

// --- Config ---
const RPC_URL = process.env.RPC_URL || "https://evm-rpc.archive.nibiru.fi";
const DATABASE_URL = process.env.DATABASE_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
const STALL_THRESHOLD_CHECKS = parseInt(process.env.STALL_THRESHOLD_CHECKS || "5", 10);

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

let lastBlockHeight = null;
let stallCount = 0;
let alertSent = false;

// --- DB Setup ---
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
  // Add column if table already existed without it
  await pool.query(`
    ALTER TABLE rpc_health_logs
    ADD COLUMN IF NOT EXISTS uptime_24h NUMERIC(5,2)
  `);
  console.log("Database table ready");
}

// --- Uptime ---
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
    if (total === "0") return null;
    return parseFloat(((parseInt(healthy) / parseInt(total)) * 100).toFixed(2));
  } catch {
    return null;
  }
}

// --- Telegram ---
async function sendTelegramAlert(message, uptime) {
  const uptimeLine = uptime !== null && uptime !== undefined
    ? `\nUptime (24h): \`${uptime}%\``
    : "";
  message = message + uptimeLine;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram not configured, skipping alert");
    return;
  }
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        }),
      }
    );
  } catch (err) {
    console.error("Failed to send Telegram alert:", err.message);
  }
}

// --- Poll ---
async function poll() {
  const start = Date.now();
  let blockHeight = null;
  let statusCode = null;
  let isHealthy = false;
  let error = null;

  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 1,
      }),
      timeout: 10000,
    });

    statusCode = res.status;
    const data = await res.json();

    if (data.result) {
      blockHeight = parseInt(data.result, 16);
      isHealthy = true;
    } else {
      error = data.error ? JSON.stringify(data.error) : "No result in response";
    }
  } catch (err) {
    error = err.message;
  }

  const responseTime = Date.now() - start;
  const uptime = await getUptime24h();

  // Stall detection
  if (blockHeight !== null && lastBlockHeight !== null) {
    if (blockHeight <= lastBlockHeight) {
      stallCount++;
    } else {
      if (stallCount >= STALL_THRESHOLD_CHECKS && alertSent) {
        await sendTelegramAlert(
          `✅ *Nibiru Archive Node Recovered*\nBlock height advancing again: \`${blockHeight}\``,
          uptime
        );
        alertSent = false;
      }
      stallCount = 0;
    }
  }

  if (blockHeight !== null) {
    lastBlockHeight = blockHeight;
  }

  // Alert on stall
  if (stallCount >= STALL_THRESHOLD_CHECKS && !alertSent) {
    await sendTelegramAlert(
      `⚠️ *Nibiru Archive Node Stalled*\nBlock height stuck at \`${blockHeight}\` for ${stallCount} consecutive checks (${(stallCount * POLL_INTERVAL_MS) / 1000}s)`,
      uptime
    );
    alertSent = true;
  }

  // Alert on down
  if (!isHealthy && !alertSent) {
    await sendTelegramAlert(
      `🔴 *Nibiru Archive Node Down*\nEndpoint: \`${RPC_URL}\`\nError: ${error || "Unknown"}`,
      uptime
    );
    alertSent = true;
  }

  // Recovery from down
  if (isHealthy && alertSent && stallCount < STALL_THRESHOLD_CHECKS) {
    await sendTelegramAlert(
      `✅ *Nibiru Archive Node Back Online*\nBlock height: \`${blockHeight}\``,
      uptime
    );
    alertSent = false;
  }

  // Log to DB
  try {
    await pool.query(
      `INSERT INTO rpc_health_logs (block_height, response_time_ms, status_code, is_healthy, error, uptime_24h)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [blockHeight, responseTime, statusCode, isHealthy, error, uptime]
    );
  } catch (dbErr) {
    console.error("DB write failed:", dbErr.message);
  }

  const status = isHealthy ? "✓" : "✗";
  console.log(
    `[${new Date().toISOString()}] ${status} block=${blockHeight} time=${responseTime}ms status=${statusCode} stall=${stallCount}`
  );
}

// --- Main ---
async function main() {
  console.log(`Nibiru RPC Listener starting`);
  console.log(`Endpoint: ${RPC_URL}`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`Stall threshold: ${STALL_THRESHOLD_CHECKS} checks`);

  await initDb();

  // Initial poll
  await poll();

  // Schedule recurring polls
  setInterval(poll, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
