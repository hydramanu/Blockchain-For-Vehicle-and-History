import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { dataDir, readJson, saveJson } from "./chain.js";

const roles = ["service", "seller", "attacker"];
const durationMs = 60 * 60 * 1000;
const hash = (value) => createHash("sha256").update(value).digest();

export function rateLimit(limit, intervalMs) {
  const counts = new Map();
  setInterval(() => counts.clear(), intervalMs).unref();
  return (req, res, next) => {
    const count = (counts.get(req.ip) || 0) + 1;
    counts.set(req.ip, count);
    if (count > limit) return res.status(429).json({ error: "Too many requests. Try again shortly." });
    next();
  };
}

export async function createAccessControl() {
  const path = join(dataDir, "access.json");
  let codes = await readJson(path);
  if (!codes) {
    codes = Object.fromEntries(roles.map((role) => [role, randomBytes(16).toString("hex")]));
    await saveJson(path, codes);
  }
  const key = randomBytes(32);
  const sign = (payload) => createHmac("sha256", key).update(payload).digest("hex");

  return {
    login(req, res) {
      const { role, code } = req.body || {};
      if (!roles.includes(role) || typeof code !== "string" || !timingSafeEqual(hash(code), hash(codes[role]))) {
        return res.status(401).json({ error: "Invalid access code for this role." });
      }
      const expiresAt = Date.now() + durationMs;
      const payload = `${role}.${expiresAt}`;
      res.set("Cache-Control", "no-store").json({ token: `${payload}.${sign(payload)}`, expiresAt });
    },
    requireRole(...allowed) {
      return (req, res, next) => {
        const token = req.get("authorization")?.match(/^Bearer ([a-z]+)\.(\d+)\.([a-f0-9]{64})$/i);
        if (!token || Number(token[2]) <= Date.now() ||
            !timingSafeEqual(Buffer.from(token[3], "hex"), Buffer.from(sign(`${token[1]}.${token[2]}`), "hex"))) {
          return res.status(401).json({ error: "Unlock this role with its access code first." });
        }
        if (!allowed.includes(token[1])) {
          return res.status(403).json({ error: "This role cannot perform that operation." });
        }
        req.accessRole = token[1];
        next();
      };
    },
  };
}
