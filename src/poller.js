const fetch = require("node-fetch");
const { RPC_URL, POLL_INTERVAL_MS, STALL_THRESHOLD_CHECKS } = require("./config");
const { recordCheck, getUptime, logEvent } = require("./db");
const { formatDetailedError } = require("./errors");
const { sendAlert } = require("./telegram");

let lastBlockHeight = null;
let stallCount = 0;
let alertSent = false;
let consecutiveFailures = 0;
let lastHealthy = null; // track state changes

function getStallCount() { return stallCount; }
function getLastBlockHeight() { return lastBlockHeight; }
function isCurrentlyHealthy() { return lastHealthy; }

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
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
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

  // Record every check for uptime calculation
  recordCheck(isHealthy);

  const uptime = getUptime(24);

  // Log event only on state changes
  if (lastHealthy !== null && lastHealthy !== isHealthy) {
    if (isHealthy) {
      logEvent("recovery", { blockHeight, responseTime, message: "Node back online" });
    } else {
      logEvent("down", { blockHeight, responseTime, statusCode, error });
    }
  }

  // Stall detection
  if (blockHeight !== null && lastBlockHeight !== null) {
    if (blockHeight <= lastBlockHeight) {
      stallCount++;
    } else {
      if (stallCount >= STALL_THRESHOLD_CHECKS && alertSent) {
        logEvent("stall_recovery", { blockHeight, message: `Block advancing again after ${stallCount} stall checks` });
        await sendAlert(`✅ *Nibiru Node Recovered*\nBlock height advancing again: \`${blockHeight}\``, uptime);
        alertSent = false;
      }
      stallCount = 0;
    }
  }

  if (blockHeight !== null) lastBlockHeight = blockHeight;

  if (stallCount >= STALL_THRESHOLD_CHECKS && !alertSent) {
    logEvent("stall", { blockHeight, message: `Block stuck for ${stallCount} checks` });
    await sendAlert(
      `⚠️ *Nibiru Node Stalled*\nBlock height stuck at \`${blockHeight}\` for ${stallCount} consecutive checks (${(stallCount * POLL_INTERVAL_MS) / 1000}s)`,
      uptime
    );
    alertSent = true;
  }

  if (!isHealthy && !alertSent) {
    const detailedMsg = formatDetailedError({ error, statusCode, responseTime, consecutiveFailures });
    await sendAlert(
      detailedMsg || `🔴 *Nibiru Node Down*\nEndpoint: \`${RPC_URL}\`\nError: ${error || "Unknown"}`,
      uptime
    );
    alertSent = true;
  }

  if (isHealthy && alertSent && stallCount < STALL_THRESHOLD_CHECKS) {
    await sendAlert(`✅ *Nibiru Node Back Online*\nBlock height: \`${blockHeight}\``, uptime);
    alertSent = false;
  }

  lastHealthy = isHealthy;

  const status = isHealthy ? "✓" : "✗";
  console.log(`[${new Date().toISOString()}] ${status} block=${blockHeight} time=${responseTime}ms status=${statusCode} stall=${stallCount}`);
}

module.exports = { poll, getStallCount, getLastBlockHeight, isCurrentlyHealthy };
