#!/usr/bin/env node
/**
 * grok-factory.mjs — create grok.com (accounts.x.ai) accounts via temp mail.
 * Standalone Playwright-core driver, engine-level stealth (featherless-proven).
 *
 * Usage:
 *   node grok-factory.mjs <email> <password> [--headed] [--registry <path>] [--code <manual-code>]
 *
 * Flow: sign-up page -> "Sign up with email" -> email -> code (emailnator poll or --code)
 *       -> Confirm -> if fresh: password/name step -> capture SSO -> registry write.
 * Exit codes: 0 = account created, 3 = existing account, 4 = blocked/captcha, 1 = error/timeout.
 *
 * Registry entry: { email, password, sso, cookies, created, model_tier: "basic" }
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const EMAILNATOR_BASE = "https://www.emailnator.com";
const CATCH_BASE = "https://api.catchmail.io";
const CATCH_DOMAINS = ["catchmail.io", "mailistry.com", "zeppost.com"];

// fingerprint rotation — fresh synthetic identity per run (xAI throttles repeated identical fingerprints after ~2 signups)
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0",
];
const TZ_POOL = ["Asia/Karachi", "America/New_York", "Europe/London", "Asia/Dubai", "Australia/Sydney"];
const LANG_POOL = ["en-US", "en-GB", "en-CA", "en-AU"];
const PLATFORM_POOL = ["Win32", "MacIntel", "Linux x86_64"];
const CONC_POOL = [4, 8,  16];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const HDRS = {
  "Accept": "application/json",
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
  "Origin": EMAILNATOR_BASE,
  "Referer": EMAILNATOR_BASE + "/inbox",
};

const STEALTH = (plat, conc) => `
Object.defineProperty(navigator, "webdriver", { get: () => undefined });
const _qp = navigator.permissions && navigator.permissions.query;
if (_qp) navigator.permissions.query = (p) => p && p.name === "notifications" ? Promise.resolve({ state: Notification.permission, onchange: null }) : _qp(p);
try { Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"], configurable: true }); } catch (e) {}
try { Object.defineProperty(navigator, "platform", { get: () => "${plat}", configurable: true }); } catch (e) {}
try { Object.defineProperty(navigator, "hardwareConcurrency", { get: () => ${conc}, configurable: true }); } catch (e) {}
`;

function findChromium() {
  const candidates = [
    process.env.PW_CHROMIUM,
    "C:/Users/hp/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    "/home/runner/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
    "/home/runner/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  // glob ms-playwright for any chromium build (win + linux)
  for (const base of [path.join(process.env.LOCALAPPDATA || "", "ms-playwright"), "/home/runner/.cache/ms-playwright", path.join(process.env.HOME || "", ".cache/ms-playwright")]) {
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        if (!d.startsWith("chromium")) continue;
        for (const sub of ["chrome-win64/chrome.exe", "chrome-linux/chrome", "chrome-linux/headless_shell"]) {
          const exe = path.join(base, d, sub);
          if (fs.existsSync(exe)) return exe;
        }
      }
    }
  }
  return null;
}

async function enatorGen() {
  const r = await fetch(`${EMAILNATOR_BASE}/api/generate-email`, {
    method: "POST", headers: HDRS, body: JSON.stringify({ ids: [3] }),
  });
  const d = await r.json();
  return d.email || d.address || String(d);
}

async function enatorList(email) {
  const r = await fetch(`${EMAILNATOR_BASE}/api/message-list`, {
    method: "POST", headers: HDRS, body: JSON.stringify({ email, limit: 20 }),
  });
  const d = await r.json();
  return (d && d.messages) || [];
}

async function enatorWaitCode(email, tries = 18, gapMs = 10000) {
  for (let i = 0; i < tries; i++) {
    try {
      const msgs = await enatorList(email);
      const hit = msgs.find((m) => /x\.ai|SpaceXAI|confirmation code/i.test((m.from || "") + (m.subject || "")));
      if (hit) {
        const m = (hit.subject || "").match(/(\d{3})[\s-]*(\d{3})/) || (hit.subject || "").match(/(\d{6})/);
        if (m) return m[1] + (m[2] ? m[2] : "");
      }
    } catch (e) { /* transient */ }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return null;
}

// --- catchmail rail (free public-domain temp mail, fresh per-account origin; avoids the burned dotGmail pool) ---
async function catchMint() {
  const local = "rail" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const domain = CATCH_DOMAINS[Math.floor(Math.random() * CATCH_DOMAINS.length)];
  return local + "@" + domain;
}
async function catchList(address) {
  const r = await fetch(CATCH_BASE + "/api/v1/mailbox?address=" + encodeURIComponent(address));
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j && j.messages) || [];
}
async function catchWaitCode(address, tries = 36, gapMs = 10000) {
  // catchmail fair-use: 1 req/sec/IP - 10s gap keeps us far under.
  for (let i = 0; i < tries; i++) {
    try {
      const msgs = await catchList(address);
      const hit = msgs.find((m) => /x\.ai|SpaceXAI|confirmation|verification|verify|grok/i.test((m.from || "") + (m.subject || "")));
      if (hit) {
        const b = await fetch(CATCH_BASE + "/api/v1/message/" + encodeURIComponent(hit.id) + "?mailbox=" + encodeURIComponent(address));
        const bj = await b.json().catch(() => ({}));
        const text = ((bj && (bj.body?.text || bj.body?.html)) || "") + " " + (hit.subject || "") + " " + (hit.from || "");
        const m33 = text.match(/(\d{3})[\s-]*(\d{3})/);
        if (m33) return m33[1] + m33[2];
        const m6 = text.match(/(?<!\d)(\d{6})(?!\d)/);
        if (m6) return m6[1];
      }
    } catch (e) { /* transient */ }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return null;
}

async function clickByText(page, text, { exact = true } = {}) {
  const loc = page.locator("button", { hasText: exact ? text : undefined }).filter({ hasText: text }).first();
  await loc.click({ timeout: 8000 });
}

async function main() {
  let [email, password] = process.argv.slice(2);
  const mailIdx = process.argv.indexOf("--mail");
  const mailRail = mailIdx >= 0 ? process.argv[mailIdx + 1] : "catchmail";
  if (mailRail === "catchmail") {
    email = await catchMint();
    console.log("minted catchmail address:", email);
  }
  const headed = process.argv.includes("--headed");
  const regIdx = process.argv.indexOf("--registry");
  const registryPath = regIdx >= 0 ? process.argv[regIdx + 1] : null;
  const codeIdx = process.argv.indexOf("--code");
  const manualCode = codeIdx >= 0 ? process.argv[codeIdx + 1] : null;
  if (!email || !password) {
    console.error("usage: node grok-factory.mjs <email> <password> [--headed] [--registry path] [--code NNNNNN]");
    process.exit(1);
  }

  const exe = findChromium();
  if (!exe) { console.error("FATAL: chromium not found (set PW_CHROMIUM)"); process.exit(1); }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: !headed,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,900",
    ],
  });
  const ctx = await browser.newContext({
    userAgent: pick(UA_POOL),
    locale: pick(LANG_POOL),
    viewport: { width: 1280 + Math.floor(Math.random() * 160), height: 800 + Math.floor(Math.random() * 160) },
    timezoneId: pick(TZ_POOL),
  });
  await ctx.addInitScript(STEALTH(pick(PLATFORM_POOL), pick(CONC_POOL)));
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  try {
    // 1. open signup
    await page.goto("https://accounts.x.ai/sign-up?redirect=grok-com", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(4000);
    // CF block check
    const bodyText = await page.textContent("body").catch(() => "");
    if (/you have been blocked|attention required/i.test(bodyText)) {
      console.error("BLOCKED: Cloudflare block page");
      process.exit(4);
    }

    // 2. email signup
    await clickByText(page, "Sign up with email");
    await page.waitForTimeout(2000);
    await page.locator("input[type=email]").fill(email);
    await clickByText(page, "Sign up");
    await page.waitForTimeout(5000);

    // 3. verify page?
    let h1 = await page.locator("h1").first().textContent().catch(() => "");
    console.log("step:", h1.trim());
    if (!/verify your email/i.test(h1 || "")) {
      console.error("UNEXPECTED: did not reach verify page. h1=" + h1);
      process.exit(1);
    }

    // 4. get code
    let code = manualCode;
    if (!code) {
      console.log("waiting for code at", email, "...");
      code = mailRail === "catchmail" ? await catchWaitCode(email) : await enatorWaitCode(email);
      if (!code) { console.error("CODE_TIMEOUT: no x.ai mail arrived"); process.exit(1); }
    }
    console.log("code:", code.slice(0, 3) + "-" + code.slice(3));

    // 5. enter code
    const codeInput = page.locator("input").last();
    await codeInput.fill(code);
    await clickByText(page, "Confirm email");
    await page.waitForTimeout(6000);

    // 6. outcome
    h1 = await page.locator("h1").first().textContent().catch(() => "");
    console.log("outcome:", h1.trim());
    if (/existing account found/i.test(h1 || "")) {
      console.error("EXISTING_ACCOUNT");
      process.exit(3);
    }
    if (!/create your password|password|tell us about yourself|create your account/i.test(h1 || "")) {
      // maybe inline text instead of h1
      const body = await page.textContent("body").catch(() => "");
      if (/existing account found/i.test(body)) { console.error("EXISTING_ACCOUNT"); process.exit(3); }
      if (!/password|first name|last name|birthday|date of birth/i.test(body)) {
        console.error("UNEXPECTED outcome. body sample: " + body.slice(0, 300));
        process.exit(1);
      }
    }

    // 7. credentials step: password + optional name/birthday
    const pw = page.locator("input[type=password]").first();
    await pw.fill(password);
    const textInputs = page.locator("input[type=text]");
    const n = await textInputs.count();
    if (n >= 1) await textInputs.nth(0).fill("Grok");
    if (n >= 2) await textInputs.nth(1).fill("User");
    // birthday selects (month/day/year) if present
    const selects = page.locator("select");
    const selCount = await selects.count();
    if (selCount >= 3) {
      await selects.nth(0).selectOption({ index: 4 });   // May
      await selects.nth(1).selectOption({ index: 11 });  // 12
      await selects.nth(2).selectOption({ value: "1998" }).catch(() => selects.nth(2).selectOption({ index: 25 }));
    }
    await page.waitForTimeout(500);
    // click the final CTA: "Create account" | "Sign up" | "Continue" | "Submit"
    for (const label of ["Create account", "Sign up", "Continue", "Submit"]) {
      const btn = page.locator("button", { hasText: label }).first();
      if (await btn.count()) { await btn.click(); break; }
    }
    await page.waitForTimeout(8000);

    // 8. detect success: URL away from sign-up or session cookie exists
    const url = page.url();
    const cookies = await ctx.cookies();
    const sso = (cookies.find((c) => c.name === "sso") || {}).value || null;
    const anon = (cookies.find((c) => c.name === "x-anon-userid") || {}).value || null;
    console.log("final url:", url);
    console.log("sso cookie:", sso ? sso.slice(0, 20) + "..." : "(none)");
    if (!sso && !anon) {
      const body = await page.textContent("body").catch(() => "");
      if (/existing account found/i.test(body)) { console.error("EXISTING_ACCOUNT"); process.exit(3); }
      console.error("NO_SESSION: signup may have failed. body sample: " + body.slice(0, 300));
      process.exit(1);
    }

    const entry = {
      email, password, sso, anon, url,
      cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain })),
      created: new Date().toISOString(),
      model_tier: "basic",
    };
    if (registryPath) {
      const reg = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, "utf8")) : [];
      reg.push(entry);
      fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2));
    }
    console.log("ACCOUNT_OK " + JSON.stringify({ email, sso: !!sso, anon: !!anon, cookies: cookies.length }));
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error("ERROR:", e.message);
    try { await browser.close(); } catch {}
    process.exit(1);
  }
}

main();