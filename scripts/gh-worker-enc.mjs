#!/usr/bin/env node
/**
 * gh-worker-enc.mjs — GH Actions egress runner WITH ENVELOPE ENCRYPTION.
 *
 * Runs on a PUBLIC repo (free unlimited runner minutes). Results MUST never
 * appear as plaintext anywhere public. This worker:
 *   1. sets GONKA_QUIET=1 on the factory (public run logs get redacted);
 *   2. creates accounts on the fresh runner IP;
 *   3. ENCRYPTS the result JSONL (AES-256-GCM + RSA-4096 OAEP envelope,
 *      public key from egress-public.pem) → writes *.jsonl.enc + *.jsonl.key
 *      (ciphertext only — safe for the public repo);
 *   4. deletes ALL plaintext temp files (never committed).
 * Only WE (holder of the private key, local) can decrypt. Anyone else sees
 * nothing but ciphertext.
 *
 * Usage:  node gh-worker-enc.mjs [count]
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, appendFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCipheriv, randomBytes, publicEncrypt, constants } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const FACTORY = join(__dir, "gonkagate-factory.mjs");
const NODE = process.execPath;
const count = parseInt(process.argv[2] || "8", 10);
const TMP_REGISTRY = join(__dir, ".tmp-registry.json");
const RUN_ID = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
const OUT_ENC = join(__dir, `runner-result-${RUN_ID}.jsonl.enc`);
const OUT_KEY = join(__dir, `runner-result-${RUN_ID}.jsonl.key`);
const PUB_PEM = readFileSync(join(__dir, "..", "egress-public.pem"), "utf8");

function log(m) { console.log(`[gh-worker-enc ${new Date().toISOString()}] ${m}`); }

if (existsSync(TMP_REGISTRY)) {
  try { const reg = JSON.parse(readFileSync(TMP_REGISTRY, "utf8").replace(/^\uFEFF/, "")); if (reg.length) log(`resuming with ${reg.length} already in temp registry`); } catch {}
} else {
  writeFileSync(TMP_REGISTRY, "[]", "utf8");
}

log(`creating ${count} accounts from this egress IP (encrypted output, quiet mode)…`);
const child = spawn(NODE, [FACTORY, "create", String(count)], {
  cwd: __dir,
  env: {
    ...process.env,
    GONKAGATE_REGISTRY: TMP_REGISTRY,
    GONKAGATE_RUNLOG: join(__dir, "runner-run.md"),
    GONKAGATE_IP_CAP: String(count),
    GONKA_QUIET: "1",   // redact emails/keys from PUBLIC run logs
  },
  stdio: "inherit",
  windowsHide: true,
});

const WATCHDOG_MS = parseInt(process.env.GH_WORKER_WATCHDOG_MS || "2400000", 10);
let watchdogFired = false;
const watchdog = setTimeout(() => {
  watchdogFired = true;
  log(`WATCHDOG: factory exceeded ${WATCHDOG_MS / 60000} min budget — killing (registry at ${tmpCount()})`);
  try { child.kill("SIGKILL"); } catch {}
}, WATCHDOG_MS);
watchdog.unref();

function tmpCount() {
  try { return JSON.parse(readFileSync(TMP_REGISTRY, "utf8").replace(/^\uFEFF/, "")).length; } catch { return 0; }
}

function encryptEnvelope(plaintext) {
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // RSA-4096 OAEP max payload ≈ 446 bytes; our envelope 32+12+16=60 bytes. Safe.
  const encKey = publicEncrypt({ key: PUB_PEM, padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.concat([aesKey, iv, tag]));
  return { ct, encKey };
}

child.on("exit", (code) => {
  clearTimeout(watchdog);
  try {
    const reg = JSON.parse(readFileSync(TMP_REGISTRY, "utf8").replace(/^\uFEFF/, ""));
    if (reg.length) {
      const plaintext = reg.map((r) => JSON.stringify(r)).join("\n") + "\n";
      const { ct, encKey } = encryptEnvelope(plaintext);
      writeFileSync(OUT_ENC, ct);
      writeFileSync(OUT_KEY, encKey);
      log(`ENCRYPTED ${reg.length} accounts → ${OUT_ENC} (ciphertext only, AES-256-GCM + RSA-4096`); 
    } else {
      log("0 accounts — no result file written.");
    }
  } catch (e) { log(`encrypt/collect error: ${e.message}`); }
  // HARD SECURITY: plaintext temp files must NEVER reach the public repo.

  for (const f of [TMP_REGISTRY, join(__dir, "runner-run.md")]) {
    try { rmSync(f, { force: true }); } catch {}
  }
  log(`done (exit ${code}${watchdogFired ? ", WATCHDOG" : ""}). Plaintext cleaned.`);
  process.exit(code ?? 0);
});