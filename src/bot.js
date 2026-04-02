const fetch = require("node-fetch");
const TelegramBot = require("node-telegram-bot-api");
const { RPC_URL, TELEGRAM_BOT_TOKEN } = require("./config");
const { getUptime, getRecentEvents, getErrorEvents, getErrorDetail } = require("./db");
const { classifyError } = require("./errors");
const { isAlertsMuted, setMute, clearMute, getMuteUntil } = require("./telegram");
const { timeSince, formatUptime } = require("./utils");
const { getStallCount, getLastBlockHeight, isCurrentlyHealthy } = require("./poller");

const processStartTime = Date.now();

function getNodeStatus() {
  const uptime = getUptime(24);
  const currentlyHealthy = isCurrentlyHealthy();
  const currentBlock = getLastBlockHeight();
  const stallCount = getStallCount();

  const statusEmoji = currentlyHealthy ? "🟢" : "🔴";
  const stallStatus = stallCount > 0 ? `⚠️ ${stallCount} stall checks` : "✅ Advancing normally";

  return [
    `${statusEmoji} *Nibiru Node Status*`,
    ``,
    `*Current State*`,
    `Health: ${currentlyHealthy ? "Online" : currentlyHealthy === null ? "Starting..." : "Offline"}`,
    `Block Height: \`${currentBlock || "N/A"}\``,
    `Block Stall: ${stallStatus}`,
    ``,
    `*Uptime*`,
    `1h: \`${getUptime(1) ?? "N/A"}%\``,
    `6h: \`${getUptime(6) ?? "N/A"}%\``,
    `24h: \`${uptime !== null ? uptime + "%" : "N/A"}\``,
    `7d: \`${getUptime(168) ?? "N/A"}%\``,
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
      await bot.sendMessage(msg.chat.id, getNodeStatus(), { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Error handling /status command:", err.message);
      await bot.sendMessage(msg.chat.id, "❌ Error fetching node status. Please try again.");
    }
  });

  bot.onText(/\/errors/, async (msg) => {
    try {
      const rows = getErrorEvents(24);

      if (rows.length === 0) {
        await bot.sendMessage(msg.chat.id, "✅ No errors in the last 24 hours.", { parse_mode: "Markdown" });
        return;
      }

      const totalErrors = rows.reduce((sum, r) => sum + r.count, 0);
      const lines = [`🔴 *Error Events (Last 24h)*`, `Total: \`${totalErrors}\` events across \`${rows.length}\` types`, ``];

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

  bot.onText(/\/error(?:\s+(\d+))?$/, async (msg, match) => {
    try {
      const n = match[1] ? parseInt(match[1], 10) : 1;
      const row = getErrorDetail(n);

      if (!row) {
        await bot.sendMessage(msg.chat.id, "✅ No errors recorded yet.", { parse_mode: "Markdown" });
        return;
      }

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
        `Response Time: \`${row.response_time_ms || "N/A"}ms\``,
        `Block Height: \`${row.block_height || "N/A"}\``,
        `Timestamp: \`${row.timestamp}\``,
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
      const intervals = [[1, "1h"], [6, "6h"], [24, "24h"], [168, "7d"]];
      const lines = [`📊 *Uptime Breakdown*`, ``];

      for (const [hours, label] of intervals) {
        const pct = getUptime(hours);
        lines.push(`${label}: \`${pct !== null ? pct + "%" : "No data"}\``);
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
      const n = Math.min(parseInt(match[1] || "10", 10), 50);
      const rows = getRecentEvents(n);

      if (rows.length === 0) {
        await bot.sendMessage(msg.chat.id, "No events yet.", { parse_mode: "Markdown" });
        return;
      }

      const typeIcons = { down: "🔴", recovery: "✅", stall: "⚠️", stall_recovery: "✅" };
      const lines = [`📋 *Last ${rows.length} Events*`, ``];
      rows.forEach(row => {
        const icon = typeIcons[row.type] || "ℹ️";
        const ago = timeSince(new Date(row.timestamp));
        const block = row.block_height || "—";
        const detail = row.message || row.error || "";
        const detailSnip = detail.length > 60 ? detail.slice(0, 60) + "..." : detail;
        lines.push(`${icon} \`${row.type}\` ${ago} ago | blk \`${block}\`${detailSnip ? " | " + detailSnip : ""}`);
      });

      await bot.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Error handling /last command:", err.message);
      await bot.sendMessage(msg.chat.id, "❌ Error fetching events. Please try again.");
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
      `/status - Current node status and uptime`,
      `/ping - Live check right now`,
      `/uptime - Uptime breakdown (1h, 6h, 24h, 7d)`,
      ``, `*Errors*`,
      `/errors - Error events from the last 24h`,
      `/error <n> - Full detail of nth most recent error`,
      `/errortypes - Reference of all error categories`,
      ``, `*Events*`,
      `/last <n> - Last n events (default 10, max 50)`,
      ``, `*Alerts*`,
      `/mute <min> - Mute alerts for n minutes (default 60)`,
      `/unmute - Re-enable alerts`,
    ].join("\n") + muteStatus;
    await bot.sendMessage(msg.chat.id, help, { parse_mode: "Markdown" });
  });

  bot.on("polling_error", (err) => console.error("Telegram polling error:", err.message));
  console.log("Telegram bot started, listening for commands");
}

module.exports = { startTelegramBot };
