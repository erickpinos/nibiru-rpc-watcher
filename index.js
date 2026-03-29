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
pool.on("error", (err) => console.error("Unexpected pool error:", err.message));

let lastBlockHeight = null;
let stallCount = 0;
let alertSent = false;
let consecutiveFailures = 0;
let alertsMuted = false;
let muteUntil = null;
const processStartTime = Date.now();

// --- Error Classification ---
function classifyError({ error, statusCode }) {
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

function formatDetailedError({ error, statusCode, responseTime, consecutiveFailures }) {
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
    if (parseInt(total) === 0) return null;
    return parseFloat(((parseInt(healthy) / parseInt(total)) * 100).toFixed(2));
  } catch (err) {
    console.error("getUptime24h query failed:", err.message);
    return null;
  }
}

// --- Telegram ---
function isAlertsMuted() {
  if (!alertsMuted) return false;
  if (muteUntil && Date.now() > muteUntil) {
    alertsMuted = false;
    muteUntil = null;
    return false;
  }
  return true;
}

async function sendTelegramAlert(message, uptime) {
  const uptimeLine = uptime !== null && uptime !== undefined
    ? `\nUptime (24h): \`${uptime}%\``
    : "";
  const fullMessage = message + uptimeLine;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram not configured, skipping alert");
    return;
  }
  if (isAlertsMuted()) {
    console.log("Alert muted, skipping");
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: fullMessage,
          parse_mode: "Markdown",
        }),
        timeout: 5000,
      }
    );
    const data = await res.json();
    if (!data.ok) {
      console.error(`Telegram API error: ${data.error_code} - ${data.description}`);
    }
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
  let insertedId = null;
  try {
    const { rows: insertedRows } = await pool.query(
      `INSERT INTO rpc_health_logs (block_height, response_time_ms, status_code, is_healthy, error)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [blockHeight, responseTime, statusCode, isHealthy, error]
    );
    insertedId = insertedRows[0].id;
  } catch (dbErr) {
    console.error("DB write failed:", dbErr.message);
  }

  const uptime = await getUptime24h();

  // Update the uptime value on the row we just inserted
  if (insertedId !== null) {
    try {
      await pool.query(
        `UPDATE rpc_health_logs SET uptime_24h = $1 WHERE id = $2`,
        [uptime, insertedId]
      );
    } catch (dbErr) {
      console.error("DB uptime update failed:", dbErr.message);
    }
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
    const detailedMsg = formatDetailedError({ error, statusCode, responseTime, consecutiveFailures });
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

  bot.onText(/\/error(?:\s+(\d+))?/, async (msg, match) => {
    try {
      const n = match[1] ? parseInt(match[1], 10) : 1;

      const { rows } = await pool.query(`
        SELECT error, status_code, response_time_ms, block_height, timestamp
        FROM rpc_health_logs
        WHERE error IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT $1
      `, [n]);

      if (rows.length === 0) {
        await bot.sendMessage(msg.chat.id, "✅ No errors recorded yet.", { parse_mode: "Markdown" });
        return;
      }

      const row = rows[rows.length - 1]; // nth most recent
      const classification = classifyError({ error: row.error, statusCode: row.status_code });
      const type = classification ? classification.category : "UNKNOWN";
      const diagnosis = classification ? classification.diagnosis : "N/A";
      const ago = timeSince(new Date(row.timestamp));

      const lines = [
        `🔍 *Error #${n}* (${ago} ago)`,
        ``,
        `*Classification*`,
        `Type: \`${type}\``,
        `Diagnosis: ${diagnosis}`,
        ``,
        `*Full Error*`,
        `\`${row.error}\``,
        ``,
        `*Context*`,
        `HTTP Status: \`${row.status_code || "N/A"}\``,
        `Response Time: \`${row.response_time_ms}ms\``,
        `Block Height: \`${row.block_height || "N/A"}\``,
        `Timestamp: \`${new Date(row.timestamp).toISOString()}\``,
      ];

      await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Error handling /error command:", err.message);
      await bot.sendMessage(msg.chat.id, "❌ Error fetching error detail. Please try again.");
    }
  });

  bot.onText(/\/ping/, async (msg) => {
    try {
      const start = Date.now();
      let pingStatus, pingError, pingStatusCode;

      try {
        const res = await fetch(RPC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
          timeout: 10000,
        });
        pingStatusCode = res.status;
        const data = await res.json();
        if (data.result) {
          const block = parseInt(data.result, 16);
          pingStatus = `🟢 Online — Block \`${block}\``;
        } else {
          pingError = data.error ? JSON.stringify(data.error) : "No result";
          pingStatus = `🔴 Error`;
        }
      } catch (err) {
        pingError = err.message;
        pingStatus = `🔴 Unreachable`;
      }

      const responseTime = Date.now() - start;
      const classification = pingError ? classifyError({ error: pingError, statusCode: pingStatusCode }) : null;

      const lines = [
        `🏓 *Ping Result*`,
        ``,
        `Status: ${pingStatus}`,
        `Response Time: \`${responseTime}ms\``,
      ];

      if (pingStatusCode) lines.push(`HTTP Status: \`${pingStatusCode}\``);
      if (pingError) lines.push(`Error: \`${pingError}\``);
      if (classification) lines.push(`Type: \`${classification.category}\``);

      lines.push(``, `Endpoint: \`${RPC_URL}\``);

      await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Error handling /ping command:", err.message);
      await bot.sendMessage(msg.chat.id, "❌ Ping failed. Please try again.");
    }
  });

  bot.onText(/\/uptime/, async (msg) => {
    try {
      const intervals = [
        ["1 hour", "1h"],
        ["6 hours", "6h"],
        ["24 hours", "24h"],
        ["7 days", "7d"],
      ];

      const lines = [`📊 *Uptime Breakdown*`, ``];

      for (const [interval, label] of intervals) {
        const { rows } = await pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE is_healthy) AS healthy,
            COUNT(*) AS total
          FROM rpc_health_logs
          WHERE timestamp > NOW() - INTERVAL '${interval}'
        `);
        const { healthy, total } = rows[0];
        if (total === "0") {
          lines.push(`${label}: \`No data\``);
        } else {
          const pct = ((parseInt(healthy) / parseInt(total)) * 100).toFixed(2);
          lines.push(`${label}: \`${pct}%\` (${healthy}/${total} checks)`);
        }
      }

      // Process uptime
      const uptimeMs = Date.now() - processStartTime;
      const uptimeDays = Math.floor(uptimeMs / 86400000);
      const uptimeHours = Math.floor((uptimeMs % 86400000) / 3600000);
      const uptimeMins = Math.floor((uptimeMs % 3600000) / 60000);
      lines.push(``, `Monitor running: \`${uptimeDays}d ${uptimeHours}h ${uptimeMins}m\``);

      await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Error handling /uptime command:", err.message);
      await bot.sendMessage(msg.chat.id, "❌ Error fetching uptime. Please try again.");
    }
  });

  bot.onText(/\/last(?:\s+(\d+))?/, async (msg, match) => {
    try {
      const n = Math.min(parseInt(match[1] || "5", 10), 20);

      const { rows } = await pool.query(`
        SELECT block_height, response_time_ms, status_code, is_healthy, error, timestamp
        FROM rpc_health_logs
        ORDER BY timestamp DESC
        LIMIT $1
      `, [n]);

      if (rows.length === 0) {
        await bot.sendMessage(msg.chat.id, "No logs yet.", { parse_mode: "Markdown" });
        return;
      }

      const lines = [`📋 *Last ${rows.length} Checks*`, ``];

      rows.forEach(row => {
        const icon = row.is_healthy ? "✅" : "🔴";
        const ago = timeSince(new Date(row.timestamp));
        const block = row.block_height || "—";
        const errSnip = row.error
          ? ` \`${row.error.length > 50 ? row.error.slice(0, 50) + "..." : row.error}\``
          : "";
        lines.push(`${icon} ${ago} ago | blk \`${block}\` | \`${row.response_time_ms}ms\`${errSnip}`);
      });

      await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Error handling /last command:", err.message);
      await bot.sendMessage(msg.chat.id, "❌ Error fetching logs. Please try again.");
    }
  });

  bot.onText(/\/mute(?:\s+(\d+))?/, async (msg, match) => {
    const minutes = parseInt(match[1] || "60", 10);
    alertsMuted = true;
    muteUntil = Date.now() + minutes * 60 * 1000;
    await bot.sendMessage(msg.chat.id, `🔇 Alerts muted for \`${minutes}\` minutes.\nUse /unmute to re-enable.`, { parse_mode: "Markdown" });
  });

  bot.onText(/\/unmute/, async (msg) => {
    alertsMuted = false;
    muteUntil = null;
    await bot.sendMessage(msg.chat.id, `🔔 Alerts re-enabled.`, { parse_mode: "Markdown" });
  });

  bot.onText(/\/response/, async (msg) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          interval_label,
          ROUND(avg_ms) AS avg_ms,
          min_ms,
          max_ms,
          ROUND(p95_ms) AS p95_ms,
          total
        FROM (
          SELECT
            '1h' AS interval_label, 1 AS sort_order,
            AVG(response_time_ms) AS avg_ms,
            MIN(response_time_ms) AS min_ms,
            MAX(response_time_ms) AS max_ms,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms) AS p95_ms,
            COUNT(*) AS total
          FROM rpc_health_logs WHERE timestamp > NOW() - INTERVAL '1 hour'
          UNION ALL
          SELECT
            '24h', 2,
            AVG(response_time_ms),
            MIN(response_time_ms),
            MAX(response_time_ms),
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms),
            COUNT(*)
          FROM rpc_health_logs WHERE timestamp > NOW() - INTERVAL '24 hours'
          UNION ALL
          SELECT
            '7d', 3,
            AVG(response_time_ms),
            MIN(response_time_ms),
            MAX(response_time_ms),
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms),
            COUNT(*)
          FROM rpc_health_logs WHERE timestamp > NOW() - INTERVAL '7 days'
        ) sub
        ORDER BY sort_order
      `);

      const lines = [`⏱ *Response Time Stats*`, ``];

      rows.forEach(r => {
        if (parseInt(r.total) === 0) {
          lines.push(`*${r.interval_label}*: No data`, ``);
        } else {
          lines.push(
            `*${r.interval_label}* (${r.total} checks)`,
            `Avg: \`${r.avg_ms}ms\` | P95: \`${r.p95_ms}ms\``,
            `Min: \`${r.min_ms}ms\` | Max: \`${r.max_ms}ms\``,
            ``
          );
        }
      });

      await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Error handling /response command:", err.message);
      await bot.sendMessage(msg.chat.id, "❌ Error fetching response stats. Please try again.");
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
    const muteStatus = isAlertsMuted()
      ? `\n\n🔇 _Alerts muted until ${new Date(muteUntil).toISOString()}_`
      : "";
    const help = [
      "*Nibiru RPC Monitor Bot*",
      "",
      `*Monitoring*`,
      `/status - Current node status and stats`,
      `/ping - Live check right now`,
      `/uptime - Uptime breakdown (1h, 6h, 24h, 7d)`,
      `/response - Response time stats with P95`,
      ``,
      `*Errors*`,
      `/errors - Error summary from the last 24h`,
      `/error <n> - Full detail of nth most recent error`,
      `/errortypes - Reference of all error categories`,
      ``,
      `*Logs*`,
      `/last <n> - Last n health checks (default 5, max 20)`,
      ``,
      `*Alerts*`,
      `/mute <min> - Mute alerts for n minutes (default 60)`,
      `/unmute - Re-enable alerts`,
    ].join("\n") + muteStatus;
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

  // Graceful shutdown
  async function shutdown() {
    console.log("Shutting down gracefully...");
    await pool.end();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Initial poll
  await poll();

  // Schedule recurring polls, guarded against concurrent execution
  let isPolling = false;
  setInterval(async () => {
    if (isPolling) return;
    isPolling = true;
    try {
      await poll();
    } catch (err) {
      console.error("Poll error:", err.message);
    } finally {
      isPolling = false;
    }
  }, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
