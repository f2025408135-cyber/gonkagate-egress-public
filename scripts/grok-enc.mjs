#!/usr/bin/env node
/**
 * grok-enc.mjs — envelope-encrypt the grok factory registry for a PUBLIC repo.
 * Mirrors gh-worker-enc.mjs (gonkagate lane): AES-256-GCM + RSA-4096 OAEP envelope.
 *   - reads egress-public.pem from the repo root (committed, public — safe);
 *   - encrypts the factory's JSON registry → scripts/runner-grok-<RUN_ID>.jsonl.enc + .key;
 *   - DELETES the plaintext registry (never committed to the public repo).
 * Only the local holder of egress-private.pem can decrypt (scripts/grok-decrypt.mjs locally).
 *
 * Usage: node scripts/grok-enc.mjs <registry.json>
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCipheriv, randomBytes, publicEncrypt, constants } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const registryPath = process.argv[2];
if (!registryPath || !existsSync(registryPath)) {
  console.error("usage: node grok-enc.mjs <registry.json>");
  process.exit(1);
}

const PUB_PEM = readFileSync(join(__dir, "..", "egress-public.pem"), "utf8");
const RUN_ID = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
const OUT_ENC = join(__dir, `runner-grok-${RUN_ID}.jsonl.enc`);
const OUT_KEY = join(__dir, `runner-grok-${RUN_ID}.jsonl.key`);

function encryptEnvelope(plaintext) {
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encKey = publicEncrypt({ key: PUB_PEM, padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.concat([aesKey, iv, tag]));
  return { ct, encKey };
}

try {
  const reg = JSON.parse(readFileSync(registryPath, "utf8").replace(/^\uFEFF/, ""));
  if (reg.length) {
    const plaintext = reg.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const { ct, encKey } = encryptEnvelope(plaintext);
    writeFileSync(OUT_ENC, ct);
    writeFileSync(OUT_KEY, encKey);
    console.log(`ENCRYPTED ${reg.length} accounts -> ${OUT_ENC} (AES-256-GCM + RSA-4096 envelope)`);
  } else {
    console.log("0 accounts — no result file written.");
  }
} catch (e) {
  console.error(`grok-enc error: ${e.message}`);
}
// HARD SECURITY: plaintext never reaches the public repo.
try { rmSync(registryPath, { force: true }); } catch {}
process.exit(0);