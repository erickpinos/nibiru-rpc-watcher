const fetch = require("node-fetch");
const {
  PEG_RPC_URL,
  LCD_URL,
  USDCE_ERC20,
  EVM_MODULE_ADDR,
  BANK_MIRROR_DENOM,
  PEG_DECIMALS,
  PEG_TOLERANCE_MICRO,
  PEG_HEARTBEAT,
} = require("./config");
const { logEvent, recordPeg } = require("./db");
const { sendAlert } = require("./telegram");

// ERC-20 balanceOf(address) selector
const BALANCE_OF = "0x70a08231";

let lastBreachAlerted = false; // avoid re-alerting the same standing breach every run

function fmt(micro) {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const base = 10n ** BigInt(PEG_DECIMALS);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(PEG_DECIMALS, "0");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}.${frac}`;
}

async function getEscrowBalance() {
  const addr = EVM_MODULE_ADDR.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const res = await fetch(PEG_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: USDCE_ERC20, data: BALANCE_OF + addr }, "latest"],
    }),
    timeout: 10000,
  });
  const data = await res.json();
  if (!data.result) throw new Error(`escrow read failed: ${data.error ? JSON.stringify(data.error) : "no result"}`);
  return BigInt(data.result);
}

async function getMirrorSupply() {
  const url = `${LCD_URL}/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(BANK_MIRROR_DENOM)}`;
  const res = await fetch(url, { timeout: 10000 });
  const data = await res.json();
  const amount = data && data.amount && data.amount.amount;
  if (amount === undefined || amount === null) {
    throw new Error(`mirror supply read failed: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return BigInt(amount);
}

// Verify the FunToken invariant: escrowed ERC-20 >= bank-mirror supply.
// escrow < supply => bank coins minted that aren't backed by escrowed USDC.e (exploit signal).
async function checkPeg() {
  let escrow, mirror;
  try {
    [escrow, mirror] = await Promise.all([getEscrowBalance(), getMirrorSupply()]);
  } catch (err) {
    console.error(`[peg] read error: ${err.message}`);
    logEvent("peg_error", { error: err.message, message: "Peg check could not read chain state" });
    return null;
  }

  const drift = escrow - mirror; // >= 0 healthy (escrow fully backs the mirror)
  const healthy = drift >= -PEG_TOLERANCE_MICRO;
  recordPeg(escrow, mirror, drift, healthy);

  console.log(
    `[peg] escrow=${fmt(escrow)} mirror=${fmt(mirror)} drift=${fmt(drift)} healthy=${healthy} USDC.e`
  );

  if (!healthy) {
    logEvent("peg_breach", {
      message: `USDC.e under-collateralized: escrow ${fmt(escrow)} < mirror ${fmt(mirror)} (drift ${fmt(drift)})`,
    });
    await sendAlert(
      [
        `🔴 *USDC.e Peg Breach*`,
        `Bank coins are NOT fully backed by escrowed USDC.e.`,
        ``,
        `Escrow (EVM module): \`${fmt(escrow)}\` USDC.e`,
        `Bank-mirror supply:  \`${fmt(mirror)}\` USDC.e`,
        `Shortfall:           \`${fmt(drift)}\` USDC.e`,
        ``,
        `Denom: \`${BANK_MIRROR_DENOM}\``,
      ].join("\n")
    );
    lastBreachAlerted = true;
  } else {
    if (lastBreachAlerted) {
      // peg recovered after a prior breach — always announce
      await sendAlert(
        `✅ *USDC.e Peg Restored*\nEscrow \`${fmt(escrow)}\` ≥ supply \`${fmt(mirror)}\` USDC.e (drift \`${fmt(drift)}\`)`
      );
      lastBreachAlerted = false;
    } else if (PEG_HEARTBEAT) {
      await sendAlert(
        `✅ *USDC.e Peg OK*\nEscrow: \`${fmt(escrow)}\`\nSupply: \`${fmt(mirror)}\`\nDrift: \`${fmt(drift)}\` USDC.e`
      );
    }
  }

  return { escrow, mirror, drift, healthy };
}

module.exports = { checkPeg, fmt };
