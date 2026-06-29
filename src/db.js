const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, "..", "data", "watcher.db");
const fs = require("fs");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      block_height INTEGER,
      response_time_ms INTEGER,
      status_code INTEGER,
      error TEXT,
      message TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS uptime_buckets (
      hour TEXT PRIMARY KEY,
      healthy INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0
    )
  `);

  // USDC.e peg readings: escrow (ERC-20 held by EVM module) vs bank-mirror supply.
  // Amounts stored as TEXT micro-units (BigInt-safe).
  db.exec(`
    CREATE TABLE IF NOT EXISTS peg_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      escrow TEXT NOT NULL,
      mirror TEXT NOT NULL,
      drift TEXT NOT NULL,
      healthy INTEGER NOT NULL
    )
  `);

  // Prepare statements after tables exist
  stmts.upsertBucket = db.prepare(`
    INSERT INTO uptime_buckets (hour, healthy, total)
    VALUES (?, ?, 1)
    ON CONFLICT(hour) DO UPDATE SET
      healthy = healthy + excluded.healthy,
      total = total + 1
  `);
  stmts.insertEvent = db.prepare(`
    INSERT INTO events (type, block_height, response_time_ms, status_code, error, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmts.insertPeg = db.prepare(`
    INSERT INTO peg_readings (escrow, mirror, drift, healthy)
    VALUES (?, ?, ?, ?)
  `);

  console.log("SQLite database ready");
}

const stmts = {};

function recordCheck(isHealthy) {
  const hour = new Date().toISOString().slice(0, 13);
  stmts.upsertBucket.run(hour, isHealthy ? 1 : 0);
}

function getUptime(intervalHours) {
  const since = new Date(Date.now() - intervalHours * 3600000).toISOString().slice(0, 13);
  const row = db.prepare(`
    SELECT COALESCE(SUM(healthy), 0) AS healthy, COALESCE(SUM(total), 0) AS total
    FROM uptime_buckets WHERE hour >= ?
  `).get(since);
  if (row.total === 0) return null;
  return parseFloat(((row.healthy / row.total) * 100).toFixed(2));
}

function logEvent(type, { blockHeight = null, responseTime = null, statusCode = null, error = null, message = null } = {}) {
  stmts.insertEvent.run(type, blockHeight, responseTime, statusCode, error, message);
}

function getRecentEvents(limit = 10) {
  return db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`).all(limit);
}

function getErrorEvents(hours = 24) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  return db.prepare(`
    SELECT error, COUNT(*) AS count, MAX(timestamp) AS last_seen
    FROM events
    WHERE error IS NOT NULL AND timestamp > ?
    GROUP BY error ORDER BY count DESC
  `).all(since);
}

function getErrorDetail(n = 1) {
  return db.prepare(`
    SELECT * FROM events WHERE error IS NOT NULL ORDER BY id DESC LIMIT ? OFFSET ?
  `).get(1, n - 1);
}

function recordPeg(escrow, mirror, drift, healthy) {
  stmts.insertPeg.run(String(escrow), String(mirror), String(drift), healthy ? 1 : 0);
}

function getLatestPeg() {
  return db.prepare(`SELECT * FROM peg_readings ORDER BY id DESC LIMIT 1`).get();
}

function cleanup() {
  // Keep 30 days of events, uptime buckets, and peg readings
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const cutoffHour = cutoff.slice(0, 13);
  db.prepare(`DELETE FROM events WHERE timestamp < ?`).run(cutoff);
  db.prepare(`DELETE FROM uptime_buckets WHERE hour < ?`).run(cutoffHour);
  db.prepare(`DELETE FROM peg_readings WHERE timestamp < ?`).run(cutoff);
}

function close() {
  db.close();
}

module.exports = { initDb, recordCheck, getUptime, logEvent, getRecentEvents, getErrorEvents, getErrorDetail, recordPeg, getLatestPeg, cleanup, close };
