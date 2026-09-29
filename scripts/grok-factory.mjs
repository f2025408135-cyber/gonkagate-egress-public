#!/usr/bin/env node
/**
 * grok-factory.mjs — create grok.com (accounts.x.ai) accounts via temp mail (v2).
 * Hardened 2026-09-29 for the 100-account GHA burst:
 *   - emailnator dotGmail MINTED FROM THE RUNNER IP when no email arg (--new / omit)
 *   - password GENERATED IN-RUN (random) when omitted — nothing sensitive in dispatch inputs
 *   - RESET-RAIL claim: reset-password?email=X auto-sends OTP (works on fresh + recycled
 *     shared-mailbox addresses; NOT suppressed for temp mail like signup OTPs)
 *   - auto signup-step first if the reset rail reports "no account"
 *   - session auto-detection after reset (sso cookie) — skips the sign-in turnstile when possible
 *   - sign-in fallback (login with email → password → wait for sso cookie)
 *   - DEVICE-FLOW OAuth mint → access_token + refresh_token (usable by grok-cli / bridge)
 *
 * Usage:
 *   node grok-factory.mjs [email] [password] [--new] [--headed] [--registry <path>] [--code NNNNNN]
 * Exit codes: 0 = account created+tokens, 3 = existing/claim-failed, 4 = blocked/captcha, 1 = error/timeout.
 *
 * Registry entry: { email, password, sso, access_token, refresh_token, expires_at, created, model_tier }
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const EMAILNATOR_BASE = "https://www.emailnator.com";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"; // grok-cli oauth client
const SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const AUTH = "https://auth.x.ai";

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0",
];
const TZ_POOL = ["Asia/Karachi", "America/New_York", "Europe/London", "Asia/Dubai", "Australia/Sydney"];
const LANG_POOL = ["en-US", "en-GB", "en-CA", "en-AU"];
const PLATFORM_POOL = ["Win32", "MacIntel", "Linux x86_64"];
const CONC_POOL = [4, 8, 16];
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
    method: "POST", headers: HDRS, body: JSON.stringify({ email, limit: 30 }),
  });
  const d = await r.json();
  return (d && d.messages) || [];
}

async function enatorWaitCode(email, tries = 18, gapMs = 10000, seen = new Set()) {
  for (let i = 0; i < tries; i++) {
    try {
      const msgs = await enatorList(email);
      const hit = msgs.find((m) => /x\.ai|SpaceXAI|confirmation code/i.test((m.from || "") + (m.subject || "")) && !seen.has(m.subject));
      if (hit) {
        const m = (hit.subject || "").match(/(\d{3})[\s-]*(\d{3})/) || (hit.subject || "").match(/(\d{6})/);
        if (m) return m[1] + (m[2] ? m[2] : "");
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

async function clickAny(page, labels) {
  for (const label of labels) {
    try {
      const btn = page.locator("button", { hasText: label }).first();
      if (await btn.count()) { await btn.click({ timeout: 5000 }); return label; }
    } catch (e) { /* try next */ }
  }
  return null;
}

async function bodyText(page) {
  try { return (await page.locator("body").innerText()) || ""; } catch { return ""; }
}

async function hasSso(ctx) {
  const cks = await ctx.cookies().catch(() => []);
  return (cks || []).some((c) => ["sso", "x-userid", "sso-rw"].includes(c.name);
}

function makePassword() {
  return "Grok!" + randomBytes(9).toString("base64url");
}

async function deviceFlow(page, ctx, log) {
  const r = await fetch(`${AUTH}/oauth2/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
  });
  if (!r.ok) throw new Error("device/code " + r.status + " " + (await r.text()).slice(0, 200));
  const dc = await r.json();
  log("device code OK, user_code:", dc.user_code);
  await page.goto(dc.verification_uri_complete, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(12000);
  const b1 = (await bodyText(page)).slice(0, 200);
  log("device page1:", b1.replace(/\s+/g, " "));
  const c4 = await clickAny(page, ["continue", "next", "authorize"]);
  log("device click1:", c4);
  await page.waitForTimeout(6000);
  const c5 = await clickAny(page, ["allow", "authorize", "approve", "continue", "yes"]);
  log("device click2:", c5);
  await page.waitForTimeout(6000);
  let token = null;
  for (let i = 0; i < 40; i++) {
    const tr = await fetch(`${AUTH}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dc.device_code, client_id: CLIENT_ID }).toString(),
    });
    const j = await tr.json().catch(() => ({}));
    if (j.access_token) { token = j; break; }
    if (j.error === "authorization_pending") { await new Promise((r) => setTimeout(r, 5000)); continue; }
    if (j.error === "slow_down") { await new Promise((r) => setTimeout(r, 7000)); continue; }
    throw new Error("token poll: " + JSON.stringify(j));
  }
  if (!token) throw new Error("token poll timeout");
  return token;
}

async function main() {
  // robust arg parse: email/password are the FIRST non-flag positionals
  const args = process.argv.slice(2);
  const opts = { registry: null, code: null, headed: false, new: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--registry") { opts.registry = args[++i] || null; }
    else if (a === "--code") { opts.code = args[++i] || null; }
    else if (a === "--headed") { opts.headed = true; }
    else if (a === "--new") { opts.new = true; }
    else if (a.startsWith("--")) { /* skip unknown flags */ }
    else positional.push(a);
  }
  const emailArg = positional[0] || null;
  const passwordArg = positional[1] || null;
  const registryPath = opts.registry;
  const manualCode = opts.code;
  const headed = opts.headed;
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

  let email = emailArg;
  if (!email || opts.new) {
    email = await enatorGen();
    log("MINTED EMAIL:", email);
  }
  let password = passwordArg;
  if (!password) {
    password = makePassword();
    log("generated random password (in-run)");
  }
  log("email:", email);

  const exe = findChromium();
  if (!exe) { console.error("FATAL: chromium not found (set PW_CHROMIUM)"); process.exit(1); }

  const browser = await chromium.launch({
    executablePath: exe,
    headless: !headed,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
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
    const enc = encodeURIComponent(email);
    // pre-snapshot inbox to skip stale codes
    const seen = new Set();
    try { for (const m of await enatorList(email)) if (m.subject) seen.add(m.subject); } catch {}

    // ---- 1. reset-password rail (auto-sends code) ----
    await page.goto(`https://accounts.x.ai/reset-password?email=${enc}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(10000);
    let b = await bodyText(page);
    log("reset page:", b.replace(/\s+/g, " ").slice(0, 160));
    if (/you have been blocked|attention required/i.test(b)) { console.error("BLOCKED: Cloudflare block page"); process.exit(4); }
    if (/too many code requests/i.test(b)) {
      log("RATE_LIMITED — waiting 60s then retrying send");
      await page.waitForTimeout(60000);
      await page.goto(`https://accounts.x.ai/reset-password?email=${enc}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(10000);
      b = await bodyText(page);
      log("reset page after wait:", b.replace(/\s+/g, " ").slice(0, 160));
    }
    if (/no account|doesn't exist|not found|invalid email/i.test(b)) {
      log("EMAIL NOT REGISTERED — doing signup step first");
      await page.goto("https://accounts.x.ai/sign-up?redirect=grok-com", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(10000);
      await clickAny(page, ["sign up with email"]);
      await page.waitForTimeout(3000);
      await page.locator("input[type=email], input[name=email]").first().fill(email);
      await page.waitForTimeout(500);
      await clickAny(page, ["sign up"]);
      await page.waitForTimeout(8000);
      await page.goto(`https://accounts.x.ai/reset-password?email=${enc}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(10000);
      b = await bodyText(page);
      log("reset page after signup:", b.replace(/\s+/g, " ").slice(0, 160));
    }
    // if it didn't auto-send (turnstile gating), click the send button
    if (!/verify your email|code/i.test(b)) {
      const c = await clickAny(page, ["reset password", "send reset code", "send code", "continue"]);
      log("trigger send click:", c);
      await page.waitForTimeout(8000);
      b = await bodyText(page);
      log("reset page after click:", b.replace(/\s+/g, " ").slice(0, 160));
    }

    // ---- 2. wait for + enter code ----
    const code = manualCode || (await enatorWaitCode(email, 18, 10000, seen));
    if (!code) { console.error("CODE_TIMEOUT: no x.ai mail arrived at " + email); process.exit(1); }
    log("code:", code.slice(0, 3) + "-" + code.slice(3));
    const codeInput = page.locator("input[name=code]").first();
    if (await codeInput.count()) await codeInput.fill(code);
    else await page.locator("input").last().fill(code);
    await page.waitForTimeout(500);
    const c1 = await clickAny(page, ["continue", "confirm email", "verify"]);
    log("clicked code-continue:", c1);
    await page.waitForTimeout(7000);

    // ---- 3. set new password ----
    b = await bodyText(page);
    log("after code:", b.replace(/\s+/g, " ").slice(0, 200));
    if (/password/i.test(b)) {
      const pws = await page.locator("input[type=password]").count();
      await page.locator("input[type=password]").nth(0).fill(password);
      if (pws >= 2) await page.locator("input[type=password]").nth(1).fill(password);
      await page.waitForTimeout(500);
      const c2 = await clickAny(page, ["reset password", "save password", "continue", "submit"]);
      log("clicked password-save:", c2);
      await page.waitForTimeout(8000);
    }
    b = await bodyText(page);
    log("post-password page:", b.replace(/\s+/g, " ").slice(0, 200));
    if (/blocked|authentication failure/i.test(b)) throw new Error("ACCOUNT_BLOCKED: " + email);
    if (/successful|password.*(reset|changed|updated)|sign in|account/i.test(b)) log("PASSWORD SET OK");

    // ---- 4. session: auto via reset OR sign-in fallback ----
    let authed = false;
    await page.waitForTimeout(4000);
    if (await hasSso(ctx)) {
      authed = true;
      log("session auto-established after reset (sso cookie present)");
    }
    if (!authed) {
      log("no sso after reset — doing sign-in");
      await page.goto("https://accounts.x.ai/sign-in?redirect=grok-com", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(10000);
      await clickAny(page, ["login with email"]);
      await page.waitForTimeout(4000);
      await page.locator("input[name=email], input[type=email]").first().fill(email);
      await page.waitForTimeout(500);
      await clickAny(page, ["next"]);
      await page.waitForTimeout(6000);
      await page.locator("input[name=password], input[type=password]").first().fill(password);
      await page.waitForTimeout(12000); // turnstile auto-solve
      const c3 = await clickAny(page, ["login"]);
      log("clicked login:", c3);
      await page.waitForTimeout(4000);
      if (!c3) {
        const r3 = await page.evaluate(`(() => {
          const els = [...document.querySelectorAll('button, [role=button], input[type=submit]')];
          const b = els.find(x => (x.innerText || x.value || '').trim().toLowerCase() === 'login');
          if (b) { b.click(); return 'login-exact2'; }
          return null;
        })()`);
        log("login fallback:", r3);
      }
      for (let i = 0; i < 30; i++) {
        if (await hasSso(ctx)) { authed = true; break; }
        const u = await page.evaluate("location.href").catch(() => "");
        if (/grok\.com/.test(String(u))) { authed = true; break; }
        await page.waitForTimeout(2000);
      }
    }
    log("authed:", authed);
    if (!authed) throw new Error("NO_AUTH: sign-in did not establish a session for " + email);

    // ---- 5. device-flow OAuth mint ----
    const token = await deviceFlow(page, ctx, log);
    log("TOKEN OK access:", token.access_token.length, "refresh:", token.refresh_token ? token.refresh_token.length : 0, "expires_in:", token.expires_in);

    // ---- 6. registry ----
    const cookies = await ctx.cookies();
    const sso = (cookies.find((c) => c.name === "sso") || {}).value || null;
    const entry = {
      email, password, sso,
      access_token: token.access_token,
      refresh_token: token.refresh_token || "",
      expires_at: Date.now() + (token.expires_in || 21600) * 1000,
      created: new Date().toISOString(),
      model_tier: "basic",
      source: "grok-factory-v2",
    };
    if (registryPath) {
      const reg = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, "utf8")) : [];
      reg.push(entry);
      fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2));
    }
    console.log("ACCOUNT_OK " + JSON.stringify({ email, sso: !!sso, token: token.access_token.length }));
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error("ERROR:", e.message);
    try { await browser.close(); } catch {}
    process.exit(1);
  }
}

main();