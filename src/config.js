const RPC_URL = process.env.RPC_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
const STALL_THRESHOLD_CHECKS = parseInt(process.env.STALL_THRESHOLD_CHECKS || "5", 10);

// --- USDC.e peg check (FunToken escrow vs bank-mirror supply) ---
// The EVM module account escrows the real ERC-20 USDC.e; the bank module mints a
// 1:1 mirror denom (erc20/<addr>). Invariant: escrow >= mirror supply. A breach
// (escrow < supply) means bank coins exist that aren't backed — a real exploit signal.
// Decoupled from RPC_URL on purpose: the peg must verify even when the monitored node
// is the one under stress. Defaults are mainnet public endpoints; override via env.
const LCD_URL = process.env.LCD_URL || "https://lcd.nibiru.fi";
const PEG_RPC_URL = process.env.PEG_RPC_URL || "https://evm-rpc.nibiru.fi";
const USDCE_ERC20 = process.env.USDCE_ERC20 || "0x0829F361A05D993d5CEb035cA6DF3446b060970b";
const EVM_MODULE_ADDR = process.env.EVM_MODULE_ADDR || "0x603871c2ddd41c26ee77495e2e31e6de7f9957e0";
const BANK_MIRROR_DENOM = process.env.BANK_MIRROR_DENOM || `erc20/${USDCE_ERC20}`;
const PEG_DECIMALS = parseInt(process.env.PEG_DECIMALS || "6", 10);
const PEG_CHECK_INTERVAL_MS = parseInt(process.env.PEG_CHECK_INTERVAL_MS || "86400000", 10); // 24h
const PEG_TOLERANCE_MICRO = BigInt(process.env.PEG_TOLERANCE_MICRO || "0"); // allowed escrow-shortfall before alert
const PEG_HEARTBEAT = process.env.PEG_HEARTBEAT !== "false"; // send the daily peg status even when healthy; set "false" to only alert on breach

module.exports = {
  RPC_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MS,
  STALL_THRESHOLD_CHECKS,
  LCD_URL,
  PEG_RPC_URL,
  USDCE_ERC20,
  EVM_MODULE_ADDR,
  BANK_MIRROR_DENOM,
  PEG_DECIMALS,
  PEG_CHECK_INTERVAL_MS,
  PEG_TOLERANCE_MICRO,
  PEG_HEARTBEAT,
};
