const fetch = require("node-fetch");
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = require("./config");

let alertsMuted = false;
let muteUntil = null;

function isAlertsMuted() {
  if (!alertsMuted) return false;
  if (muteUntil && Date.now() > muteUntil) {
    alertsMuted = false;
    muteUntil = null;
    return false;
  }
  return true;
}

function setMute(minutes) {
  alertsMuted = true;
  muteUntil = Date.now() + minutes * 60 * 1000;
}

function clearMute() {
  alertsMuted = false;
  muteUntil = null;
}

function getMuteUntil() {
  return muteUntil;
}

async function sendAlert(message, uptime) {
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

module.exports = { sendAlert, isAlertsMuted, setMute, clearMute, getMuteUntil };
