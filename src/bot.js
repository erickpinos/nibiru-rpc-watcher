const fetch = require("node-fetch");
const TelegramBot = require("node-telegram-bot-api");
const { RPC_URL, TELEGRAM_BOT_TOKEN } = require("./config");
const { pool, getUptime24h } = require("./db");
const { classifyError } = require("./errors");
const { isAlertsMuted, setMute, clearMute, getMuteUntil } = require("./telegram");
const { timeSince, formatUptime } = require("./utils");
const { getStallCount } = require("./poller");

const processStartTime = Date.now();

async function getNodeStatus() {
  const uptime = await getUptime24h();

  const { rows: recentLogs } = await pool.query(`
    SELECT block_height, response_time_ms, is_healthy, timestamp
    FROM rpc_health_logs ORDER BY timestamp DESC LIMIT 10
  `);

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
  const stallCount = getStallCount();
  const blocksAdvanced = h.max_block && h.min_block
    ? parseInt(h.max_block) - parseInt(h.min_block) : "N/A";

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
    `Monitor Uptime: \`${formatUptime(Date.now() - processStartTime)}\``,
    `Endpoint: \`${RPC_URL}\``,
  ].join("\n");
}

function startTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("Telegram bot not started: TELEGRAM_BOT_TOKEN not configured");
    return;
  }

  const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

  bot.onText(/\/status/, async (msg) => {
    try {
      await bot.sendMessage(msg.chat.id, await getNodeStatus(), { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Error handling /status command:", err.message);
      await bot.sendMessage(msg.chat.id, "❌ Error fetching node status. Please try again.");
    }
  });

  bot.onText(/\/errors/, async (msg) => {
    try {
      const { rows } = await pool.query(`
        SELECT error, COUNT(*) AS count, MAX(timestamp) AS last_seen
        FROM rpc_health_logs
        WHERE error IS NOT NULL AND timestamp > NOW() - INTERVAL '24 hours'
        GROUP BY error ORDER BY count DESC
      `);

      if (rows.length === 0) {
        await bot.sendMessage(msg.chat.id, "✅ No errors in the last 24 hours.", { parse_mode: "Markdown" });
        return;
      }

      const totalErrors = rows.reduce((sum, r) => sum + parseInt(r.count), 0);
      const lines = [`🔴 *Errors (Last 24h)*`, `Total: \`${totalErrors}\` errors across \`${rows.length}\` types`, ``];

      rows.forEach((row, i) => {
        const classification = classifyError({ error: row.error, statusCode: null });
        const type = classification ? classification.category : "UNKNOWN";
        const ago = timeSince(new Date(row.last_seen));
        lines.push(
          `*${i + 1}. ${type}* (×${row.count})`,
          `\`${row.error.length > 120 ? row.error.slice(0, 120) + "..." : row.error}\``,
          `Last seen: ${ago} ago`, ``
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
        FROM rpc_health_logs WHERE error IS NOT NULL ORDER BY timestamp DESC LIMIT $1
      `, [n]);

      if (rows.length === 0) {
        await bot.sendMessage(msg.chat.id, "✅ No errors recorded yet.", { parse_mode: "Markdown" });
        return;
      }

      const row = rows[rows.length - 1];
      const classification = classifyError({ error: row.error, statusCode: row.status_code });
      const type = classification ? classification.category : "UNKNOWN";
      const diagnosis = classification ? classification.diagnosis : "N/A";
      const ago = timeSince(new Date(row.timestamp));

      const lines = [
        `🔍 *Error #${n}* (${ago} ago)`, ``,
        `*Classification*`, `Type: \`${type}\``, `Diagnosis: ${diagnosis}`, ``,
        `*Full Error*`, `\`${row.error}\``, ``,
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
          pingStatus = `🟢 Online — Block \`${parseInt(data.result, 16)}\``;
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
      const lines = [`🏓 *Ping Result*`, ``, `Status: ${pingStatus}`, `Response Time: \`${responseTime}ms\``];
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
      const intervals = [["1 hour", "1h"], ["6 hours", "6h"], ["24 hours", "24h"], ["7 days", "7d"]];
      const lines = [`📊 *Uptime Breakdown*`, ``];

      for (const [interval, label] of intervals) {
        const { rows } = await pool.query(`
          SELECT COUNT(*) FILTER (WHERE is_healthy) AS healthy, COUNT(*) AS total
          FROM rpc_health_logs WHERE timestamp > NOW() - INTERVAL '${interval}'
        `);
        const { healthy, total } = rows[0];
        if (total === "0") {
          lines.push(`${label}: \`No data\``);
        } else {
          const pct = ((parseInt(healthy) / parseInt(total)) * 100).toFixed(2);
          lines.push(`${label}: \`${pct}%\` (${healthy}/${total} checks)`);
        }
      }

      lines.push(``, `Monitor running: \`${formatUptime(Date.now() - processStartTime)}\``);
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
        FROM rpc_health_logs ORDER BY timestamp DESC LIMIT $1
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
    setMute(minutes);
    await bot.sendMessage(msg.chat.id, `🔇 Alerts muted for \`${minutes}\` minutes.\nUse /unmute to re-enable.`, { parse_mode: "Markdown" });
  });

  bot.onText(/\/unmute/, async (msg) => {
    clearMute();
    await bot.sendMessage(msg.chat.id, `🔔 Alerts re-enabled.`, { parse_mode: "Markdown" });
  });

  bot.onText(/\/response/, async (msg) => {
    try {
      const { rows } = await pool.query(`
        SELECT interval_label, ROUND(avg_ms) AS avg_ms, min_ms, max_ms, ROUND(p95_ms) AS p95_ms, total
        FROM (
          SELECT '1h' AS interval_label, 1 AS sort_order,
            AVG(response_time_ms) AS avg_ms, MIN(response_time_ms) AS min_ms,
            MAX(response_time_ms) AS max_ms,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms) AS p95_ms,
            COUNT(*) AS total
          FROM rpc_health_logs WHERE timestamp > NOW() - INTERVAL '1 hour'
          UNION ALL
          SELECT '24h', 2, AVG(response_time_ms), MIN(response_time_ms),
            MAX(response_time_ms),
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms),
            COUNT(*)
          FROM rpc_health_logs WHERE timestamp > NOW() - INTERVAL '24 hours'
          UNION ALL
          SELECT '7d', 3, AVG(response_time_ms), MIN(response_time_ms),
            MAX(response_time_ms),
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms),
            COUNT(*)
          FROM rpc_health_logs WHERE timestamp > NOW() - INTERVAL '7 days'
        ) sub ORDER BY sort_order
      `);

      const lines = [`⏱ *Response Time Stats*`, ``];
      rows.forEach(r => {
        if (parseInt(r.total) === 0) {
          lines.push(`*${r.interval_label}*: No data`, ``);
        } else {
          lines.push(
            `*${r.interval_label}* (${r.total} checks)`,
            `Avg: \`${r.avg_ms}ms\` | P95: \`${r.p95_ms}ms\``,
            `Min: \`${r.min_ms}ms\` | Max: \`${r.max_ms}ms\``, ``
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

    const lines = [`📖 *All Monitored Error Types*`, ``];
    types.forEach(([type, desc]) => lines.push(`*${type}*`, desc, ``));
    lines.push(`_These categories are used in_ /errors _and_ 🔴 _down alerts._`);

    await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.onText(/\/help/, async (msg) => {
    const muteStatus = isAlertsMuted()
      ? `\n\n🔇 _Alerts muted until ${new Date(getMuteUntil()).toISOString()}_`
      : "";
    const help = [
      "*Nibiru RPC Monitor Bot*", "",
      `*Monitoring*`,
      `/status - Current node status and stats`,
      `/ping - Live check right now`,
      `/uptime - Uptime breakdown (1h, 6h, 24h, 7d)`,
      `/response - Response time stats with P95`,
      ``, `*Errors*`,
      `/errors - Error summary from the last 24h`,
      `/error <n> - Full detail of nth most recent error`,
      `/errortypes - Reference of all error categories`,
      ``, `*Logs*`,
      `/last <n> - Last n health checks (default 5, max 20)`,
      ``, `*Alerts*`,
      `/mute <min> - Mute alerts for n minutes (default 60)`,
      `/unmute - Re-enable alerts`,
    ].join("\n") + muteStatus;
    await bot.sendMessage(msg.chat.id, help, { parse_mode: "Markdown" });
  });

  bot.on("polling_error", (err) => console.error("Telegram polling error:", err.message));
  console.log("Telegram bot started, listening for /status commands");
}

module.exports = { startTelegramBot };
