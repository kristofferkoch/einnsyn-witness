// IPv4-pinned, retrying JSON POST client for the eInnsyn API.
//
// Node's global fetch uses happy-eyeballs address selection; against
// einnsyn.no (dual A/AAAA since the 2026-08-24 Digdir incident) it latches
// onto the unreachable v6 route and surfaces ETIMEDOUT without falling back.
// These helpers pin DNS to the A record (family: 4) and retry transient
// failures with bounded backoff — gentle by design, the target may be under
// load. Zero dependencies; works on Node 20 and 22.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const RETRIABLE_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
]);

const isRetriable = (err) =>
  RETRIABLE_ERROR_CODES.has(err.code) ||
  err.statusCode >= 500 ||
  err.statusCode === 429;

export async function postJson(url, { body, headers = {}, timeoutMs = 60000, retries = 3, family = 4 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await once(url, { body, headers, timeoutMs, family });
    } catch (err) {
      lastErr = err;
      if (!isRetriable(err) || attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

function once(url, { body, headers, timeoutMs, family }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const transport = u.protocol === "https:" ? httpsRequest : httpRequest;
    const payload = Buffer.from(JSON.stringify(body));
    const req = transport(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        family,
        headers: { ...headers, "Content-Length": payload.length },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode;
          if (status >= 200 && status < 300) {
            try {
              resolve(JSON.parse(text));
            } catch (err) {
              reject(Object.assign(new Error(`invalid JSON: ${err.message}`), { statusCode: status }));
            }
          } else {
            reject(
              Object.assign(new Error(`HTTP ${status}: ${text.slice(0, 200)}`), {
                statusCode: status,
              }),
            );
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error(`timeout after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}
