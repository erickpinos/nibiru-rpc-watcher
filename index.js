const fetch = require("node-fetch");
const { Pool } = require("pg");
const TelegramBot = require("node-telegram-bot-api");

// --- Config ---
const RPC_URL = process.env.RPC_URL;
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
let consecutiveFailures = 0;
const processStartTime = Date.now();

// --- Error Classification ---
function classifyError({ error, statusCode, responseTime }) {
  if (!error && statusCode && statusCode >= 200 && statusCode < 300) {
    return null; // No error
  }

  const errorStr = (error || "").toLowerCase();
  let category, diagnosis;

  if (errorStr.includes("econnrefused")) {
    category = "CONNECTION_REFUSED";
    diagnosis = "The server is not accepting connections. The node process is likely down or the port is not open.";
  } else if (errorStr.includes("etimedout") || errorStr.includes("timeout") || errorStr.includes("esockettimedout")) {
    category = "TIMEOUT";
    diagnosis = "The server did not respond within the timeout period. The node may be overloaded or network issues may exist.";
  } else if (errorStr.includes("econnreset")) {
    category = "CONNECTION_RESET";
    diagnosis = "The connection was reset by the server. This could indicate a crash, firewall drop, or proxy issue.";
  } else if (errorStr.includes("enotfound") || errorStr.includes("dns")) {
    category = "DNS_FAILURE";
    diagnosis = "DNS resolution failed. The domain may be misconfigured or DNS servers may be unreachable.";
  } else if (errorStr.includes("cert") || errorStr.includes("ssl") || errorStr.includes("tls")) {
    category = "TLS_ERROR";
    diagnosis = "SSL/TLS handshake failed. The certificate may be expired, invalid, or misconfigured.";
  } else if (statusCode === 429) {
    category = "RATE_LIMITED";
    diagnosis = "The server is rate limiting requests. This is NOT a node outage — the node is running but rejecting excess traffic.";
  } else if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    category = "GATEWAY_ERROR";
    diagnosis = `HTTP ${statusCode} — The reverse proxy/load balancer could not reach the backend node. The node process may be down behind the proxy.`;
  } else if (statusCode && (statusCode < 200 || statusCode >= 300)) {
    category = "HTTP_ERROR";
    diagnosis = `Unexpected HTTP status ${statusCode}.`;
  } else if (error) {
    category = "UNKNOWN";
    diagnosis = "An unclassified error occurred.";
  }

  return { category, diagnosis };
}

function formatDetailedError({ error, statusCode, responseTime, uptime, consecutiveFailures }) {
  const classification = classifyError({ error, statusCode, responseTime });
  if (!classification) return null;

  const lines = [
    `🔴 *Nibiru Node Down*`,
    ``,
    `*Error Details*`,
    `Type: \`${classification.category}\``,
    `Message: \`${error || "N/A"}\``,
  ];

  if (statusCode) {
    lines.push(`HTTP Status: \`${statusCode}\``);
  }

  lines.push(
    `Response Time: \`${responseTime}ms\``,
    `Diagnosis: ${classification.diagnosis}`,
    ``,
    `*Endpoint*`,
    `URL: \`${RPC_URL}\``,
    `Consecutive Failures: \`${consecutiveFailures}\``,
  );

  return lines.join("\n");
}

function timeSince(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

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

  if (isHealthy) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
  }

  // Log to DB before calculating uptime so the current check is included
  try {
    await pool.query(
      `INSERT INTO rpc_health_logs (block_height, response_time_ms, status_code, is_healthy, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [blockHeight, responseTime, statusCode, isHealthy, error]
    );
  } catch (dbErr) {
    console.error("DB write failed:", dbErr.message);
  }

  const uptime = await getUptime24h();

  // Update the uptime value on the row we just inserted
  try {
    await pool.query(`
      UPDATE rpc_health_logs SET uptime_24h = $1
      WHERE id = (SELECT MAX(id) FROM rpc_health_logs)
    `, [uptime]);
  } catch (dbErr) {
    console.error("DB uptime update failed:", dbErr.message);
  }

  // Stall detection
  if (blockHeight !== null && lastBlockHeight !== null) {
    if (blockHeight <= lastBlockHeight) {
      stallCount++;
    } else {
      if (stallCount >= STALL_THRESHOLD_CHECKS && alertSent) {
        await sendTelegramAlert(
          `✅ *Nibiru Node Recovered*\nBlock height advancing again: \`${blockHeight}\``,
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
      `⚠️ *Nibiru Node Stalled*\nBlock height stuck at \`${blockHeight}\` for ${stallCount} consecutive checks (${(stallCount * POLL_INTERVAL_MS) / 1000}s)`,
      uptime
    );
    alertSent = true;
  }

  // Alert on down
  if (!isHealthy && !alertSent) {
    const detailedMsg = formatDetailedError({ error, statusCode, responseTime, uptime, consecutiveFailures });
    await sendTelegramAlert(
      detailedMsg || `🔴 *Nibiru Node Down*\nEndpoint: \`${RPC_URL}\`\nError: ${error || "Unknown"}`,
      uptime
    );
    alertSent = true;
  }

  // Recovery from down
  if (isHealthy && alertSent && stallCount < STALL_THRESHOLD_CHECKS) {
    await sendTelegramAlert(
      `✅ *Nibiru Node Back Online*\nBlock height: \`${blockHeight}\``,
      uptime
    );
    alertSent = false;
  }

  const status = isHealthy ? "✓" : "✗";
  console.log(
    `[${new Date().toISOString()}] ${status} block=${blockHeight} time=${responseTime}ms status=${statusCode} stall=${stallCount}`
  );
}

// --- Status Query ---
async function getNodeStatus() {
  const uptime = await getUptime24h();

  // Recent stats from last 10 polls
  const { rows: recentLogs } = await pool.query(`
    SELECT block_height, response_time_ms, is_healthy, timestamp
    FROM rpc_health_logs
    ORDER BY timestamp DESC
    LIMIT 10
  `);

  // Stats from last hour
  const { rows: hourStats } = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE is_healthy) AS healthy,
      ROUND(AVG(response_time_ms)) AS avg_response,
      MIN(response_time_ms) AS min_response,
      MAX(response_time_ms) AS max_response,
      MAX(block_height) AS max_block,
      MIN(block_height) AS min_block
    FROM rpc_health_logs
    WHERE timestamp > NOW() - INTERVAL '1 hour'
  `);

  const h = hourStats[0] || {};
  const latest = recentLogs[0];
  const currentlyHealthy = latest ? latest.is_healthy : null;
  const currentBlock = latest ? latest.block_height : null;

  // Process uptime
  const uptimeMs = Date.now() - processStartTime;
  const uptimeDays = Math.floor(uptimeMs / 86400000);
  const uptimeHours = Math.floor((uptimeMs % 86400000) / 3600000);
  const uptimeMins = Math.floor((uptimeMs % 3600000) / 60000);
  const processUptimeStr = `${uptimeDays}d ${uptimeHours}h ${uptimeMins}m`;

  // Blocks advanced in last hour
  const blocksAdvanced = h.max_block && h.min_block
    ? parseInt(h.max_block) - parseInt(h.min_block)
    : "N/A";

  const statusEmoji = currentlyHealthy ? "🟢" : "🔴";
  const stallStatus = stallCount > 0 ? `⚠️ ${stallCount} stall checks` : "✅ Advancing normally";

  return [
    `${statusEmoji} *Nibiru Node Status*`,
    ``,
    `*Current State*`,
    `Health: ${currentlyHealthy ? "Online" : "Offline"}`,
    `Block Height: \`${currentBlock || "N/A"}\``,
    `Block Stall: ${stallStatus}`,
    ``,
    `*Last Hour Stats*`,
    `Checks: ${h.total || 0} (${h.healthy || 0} healthy)`,
    `Avg Response: \`${h.avg_response || "N/A"}ms\``,
    `Min / Max: \`${h.min_response || "N/A"}ms\` / \`${h.max_response || "N/A"}ms\``,
    `Blocks Advanced: \`${blocksAdvanced}\``,
    ``,
    `*Uptime*`,
    `24h Uptime: \`${uptime !== null ? uptime + "%" : "N/A"}\``,
    `Monitor Uptime: \`${processUptimeStr}\``,
    `Endpoint: \`${RPC_URL}\``,
  ].join("\n");
}

// --- Telegram Bot ---
function startTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("Telegram bot not started: TELEGRAM_BOT_TOKEN not configured");
    return;
  }

  const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

  bot.onText(/\/status/, async (msg) => {
    try {
      const status = await getNodeStatus();
      await bot.sendMessage(msg.chat.id, status, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Error handling /status command:", err.message);
      await bot.sendMessage(msg.chat.id, "❌ Error fetching node status. Please try again.");
    }
  });

  bot.onText(/\/errors/, async (msg) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          error,
          COUNT(*) AS count,
          MAX(timestamp) AS last_seen
        FROM rpc_health_logs
        WHERE error IS NOT NULL
          AND timestamp > NOW() - INTERVAL '24 hours'
        GROUP BY error
        ORDER BY count DESC
      `);

      if (rows.length === 0) {
        await bot.sendMessage(msg.chat.id, "✅ No errors in the last 24 hours.", { parse_mode: "Markdown" });
        return;
      }

      const totalErrors = rows.reduce((sum, r) => sum + parseInt(r.count), 0);
      const lines = [
        `🔴 *Errors (Last 24h)*`,
        `Total: \`${totalErrors}\` errors across \`${rows.length}\` types`,
        ``,
      ];

      rows.forEach((row, i) => {
        const classification = classifyError({ error: row.error, statusCode: null });
        const type = classification ? classification.category : "UNKNOWN";
        const ago = timeSince(new Date(row.last_seen));
        lines.push(
          `*${i + 1}. ${type}* (×${row.count})`,
          `\`${row.error.length > 120 ? row.error.slice(0, 120) + "..." : row.error}\``,
          `Last seen: ${ago} ago`,
          ``
        );
      });

      await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Error handling /errors command:", err.message);
      await bot.sendMessage(msg.chat.id, "❌ Error fetching error logs. Please try again.");
    }
  });

  bot.onText(/\/block(?:\s+(\d+))?/, async (msg, match) => {
    try {
      const blockNum = match[1] ? parseInt(match[1], 10) : null;

      if (!blockNum) {
        await bot.sendMessage(msg.chat.id, "Usage: `/block <number>`\nExample: `/block 12345678`", { parse_mode: "Markdown" });
        return;
      }

      // Check if we've ever seen this block in our logs
      const { rows } = await pool.query(`
        SELECT block_height, response_time_ms, status_code, is_healthy, error, timestamp, uptime_24h
        FROM rpc_health_logs
        WHERE block_height = $1
        ORDER BY timestamp DESC
      `, [blockNum]);

      if (rows.length === 0) {
        await bot.sendMessage(msg.chat.id, `❌ Block \`${blockNum}\` was never observed by this monitor. Can only look up blocks that were seen during health checks.`, { parse_mode: "Markdown" });
        return;
      }

      const first = rows[rows.length - 1];
      const last = rows[0];
      const healthyCount = rows.filter(r => r.is_healthy).length;
      const errorCount = rows.filter(r => !r.is_healthy).length;
      const avgResponse = Math.round(rows.reduce((sum, r) => sum + (r.response_time_ms || 0), 0) / rows.length);

      const lines = [
        `📦 *Block ${blockNum} Status*`,
        ``,
        `*Observations*`,
        `Times seen: \`${rows.length}\``,
        `Healthy: \`${healthyCount}\` | Errors: \`${errorCount}\``,
        `Avg Response: \`${avgResponse}ms\``,
        ``,
        `*Timeline*`,
        `First seen: \`${new Date(first.timestamp).toISOString()}\``,
        `Last seen: \`${new Date(last.timestamp).toISOString()}\` (${timeSince(new Date(last.timestamp))} ago)`,
      ];

      if (errorCount > 0) {
        const errors = rows.filter(r => r.error);
        const uniqueErrors = [...new Set(errors.map(r => r.error))];
        lines.push(``, `*Errors at this block*`);
        uniqueErrors.forEach(e => {
          const classification = classifyError({ error: e, statusCode: null });
          const type = classification ? classification.category : "UNKNOWN";
          lines.push(`• \`${type}\`: ${e.length > 80 ? e.slice(0, 80) + "..." : e}`);
        });
      }

      await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Error handling /block command:", err.message);
      await bot.sendMessage(msg.chat.id, "❌ Error fetching block info. Please try again.");
    }
  });

  bot.onText(/\/errortypes/, async (msg) => {
    const types = [
      [`CONNECTION_REFUSED`, `Server not accepting connections. Node process is likely down or port is closed.`],
      [`TIMEOUT`, `Server did not respond in time. Node may be overloaded or network issues.`],
      [`CONNECTION_RESET`, `Connection dropped mid-request. Could be a crash, firewall, or proxy issue.`],
      [`DNS_FAILURE`, `Domain name could not be resolved. DNS misconfiguration or outage.`],
      [`TLS_ERROR`, `SSL/TLS handshake failed. Expired or invalid certificate.`],
      [`RATE_LIMITED`, `HTTP 429 — Node is running but rejecting excess traffic. NOT an outage.`],
      [`GATEWAY_ERROR`, `HTTP 502/503/504 — Reverse proxy can't reach the backend node.`],
      [`HTTP_ERROR`, `Any other unexpected HTTP status code.`],
      [`UNKNOWN`, `Unclassified error that doesn't match known patterns.`],
    ];

    const lines = [
      `📖 *All Monitored Error Types*`,
      ``,
    ];

    types.forEach(([type, desc]) => {
      lines.push(`*${type}*`, desc, ``);
    });

    lines.push(`_These categories are used in_ /errors _and_ 🔴 _down alerts._`);

    await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.onText(/\/help/, async (msg) => {
    const help = [
      "*Nibiru RPC Monitor Bot*",
      "",
      `/status - Get current node status and stats`,
      `/errors - List all error types from the last 24h`,
      `/block <number> - Look up status of a specific block`,
      `/errortypes - Show all possible error categories`,
      `/help - Show this help message`,
    ].join("\n");
    await bot.sendMessage(msg.chat.id, help, { parse_mode: "Markdown" });
  });

  bot.on("polling_error", (err) => {
    console.error("Telegram polling error:", err.message);
  });

  console.log("Telegram bot started, listening for /status commands");
}

// --- Main ---
async function main() {
  console.log(`Nibiru RPC Listener starting`);
  console.log(`Endpoint: ${RPC_URL}`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`Stall threshold: ${STALL_THRESHOLD_CHECKS} checks`);

  await initDb();
  startTelegramBot();

  // Initial poll
  await poll();

  // Schedule recurring polls
  setInterval(poll, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
