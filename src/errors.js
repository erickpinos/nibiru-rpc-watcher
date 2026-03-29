const { RPC_URL } = require("./config");

const ERROR_PATTERNS = [
  { test: "econnrefused", category: "CONNECTION_REFUSED", diagnosis: "The server is not accepting connections. The node process is likely down or the port is not open." },
  { test: /etimedout|timeout|esockettimedout/, category: "TIMEOUT", diagnosis: "The server did not respond within the timeout period. The node may be overloaded or network issues may exist." },
  { test: "econnreset", category: "CONNECTION_RESET", diagnosis: "The connection was reset by the server. This could indicate a crash, firewall drop, or proxy issue." },
  { test: /enotfound|dns/, category: "DNS_FAILURE", diagnosis: "DNS resolution failed. The domain may be misconfigured or DNS servers may be unreachable." },
  { test: /cert|ssl|tls/, category: "TLS_ERROR", diagnosis: "SSL/TLS handshake failed. The certificate may be expired, invalid, or misconfigured." },
];

function classifyError({ error, statusCode }) {
  if (!error && statusCode && statusCode >= 200 && statusCode < 300) return null;

  const errorStr = (error || "").toLowerCase();

  for (const { test, category, diagnosis } of ERROR_PATTERNS) {
    const matches = test instanceof RegExp ? test.test(errorStr) : errorStr.includes(test);
    if (matches) return { category, diagnosis };
  }

  if (statusCode === 429) return { category: "RATE_LIMITED", diagnosis: "The server is rate limiting requests. This is NOT a node outage — the node is running but rejecting excess traffic." };
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) return { category: "GATEWAY_ERROR", diagnosis: `HTTP ${statusCode} — The reverse proxy/load balancer could not reach the backend node. The node process may be down behind the proxy.` };
  if (statusCode && (statusCode < 200 || statusCode >= 300)) return { category: "HTTP_ERROR", diagnosis: `Unexpected HTTP status ${statusCode}.` };
  if (error) return { category: "UNKNOWN", diagnosis: "An unclassified error occurred." };

  return null;
}

function formatDetailedError({ error, statusCode, responseTime, consecutiveFailures }) {
  const classification = classifyError({ error, statusCode });
  if (!classification) return null;

  const lines = [
    `🔴 *Nibiru Node Down*`,
    ``,
    `*Error Details*`,
    `Type: \`${classification.category}\``,
    `Message: \`${error || "N/A"}\``,
  ];

  if (statusCode) lines.push(`HTTP Status: \`${statusCode}\``);

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

module.exports = { classifyError, formatDetailedError };
