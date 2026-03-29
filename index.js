const { RPC_URL, POLL_INTERVAL_MS, STALL_THRESHOLD_CHECKS } = require("./src/config");
const { pool, initDb } = require("./src/db");
const { poll } = require("./src/poller");
const { startTelegramBot } = require("./src/bot");

async function main() {
  console.log(`Nibiru RPC Watcher starting`);
  console.log(`Endpoint: ${RPC_URL}`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`Stall threshold: ${STALL_THRESHOLD_CHECKS} checks`);

  await initDb();
  startTelegramBot();

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await poll();

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

async function shutdown() {
  console.log("Shutting down gracefully...");
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
