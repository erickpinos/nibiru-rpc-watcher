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

module.exports = {
  RPC_URL,
  DATABASE_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MS,
  STALL_THRESHOLD_CHECKS,
};
