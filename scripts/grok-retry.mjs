#!/usr/bin/env node
/**
 * grok-retry.mjs — retry the grok factory until an xAI account is created.
 * xAI silently throttles verification-code delivery per-IP/pool on a rolling
 * window (2 early deliveries, then suppression). This loop mints a FRESH
 * emailnator dotGmail + runs the factory (with fingerprint rotation) every
 * RETRY_GAP_MIN minutes until success or MAX_ATTEMPTS.
 *
 * Usage: node grok-retry.mjs [--attempts N] [--gap-min M] [--registry path]
 * Exit 0 on account created (or attempts exhausted); prints progress lines.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const EMAILNATOR_BASE = "https://www.emailnator.com";
const HDRS = {
  "Accept": "application/json",
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
  "Origin": EMAILNATOR_BASE,
  "Referer": EMAILNATOR_BASE + "/inbox",
};

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const attempts = parseInt(arg("--attempts", "12"), 10);
const gapMin = parseInt(arg("--gap-min", "40"), 10);
const registry = arg("--registry", "F:\\grok-tools\\grok-registry-local.json");
const factory = arg("--factory", "F:\\grok-tools\\grok-factory.mjs");
const log = (m) => console.log("[" + new Date().toISOString() + "] " + m);

async function mint() {
  const r = await fetch(`${EMAILNATOR_BASE}/api/generate-email`, {
    method: "POST", headers: HDRS, body: JSON.stringify({ ids: [3] }),
  });
  const d = await r.json();
  return d.email || d.address;
}

function runFactory(addr, pw, attempt) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [factory, addr, pw, "--mail", "emailnator", "--registry", registry], { stdio: "inherit", windowsHide: true });
    child.on("exit", (code) => resolve(code));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pw = "GrokRetry" + Math.floor(Math.random() * 9000 + 1000) + "x";
  log("grok-retry loop: attempts=" + attempts + " gap=" + gapMin + "min registry=" + registry);
  for (let a = 1; a <= attempts; a++) {
    const addr = await mint();
    log("attempt " + a + "/" + attempts + " addr=" + addr);
    const code = await runFactory(addr, pw, a);
    if (code === 0) { log("ACCOUNT_CREATED " + addr); process.exit(0); }
    if (code === 3) { log("existing account for " + addr + " (pool recycle) — retrying"); }
    else if (code === 4) { log("blocked/captcha — retrying"); }
    else { log("no code (timeout) or error exit=" + code); }
    if (a < attempts) {
      log("sleeping " + gapMin + " min before next attempt");
      await sleep(gapMin * 60 * 1000);
    }
  }
  log("ATTEMPTS_EXHAUSTED — no account created this run. Rerun later.");
  process.exit(1);
}

main();