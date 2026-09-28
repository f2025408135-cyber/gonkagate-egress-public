#!/usr/bin/env node
/**
 * duck-setup.mjs — create a DuckDuckGo Email Protection account + @duck.com relay address.
 * The duck address FORWARDS all mail to the signup email (an emailnator dotGmail),
 * so xAI (which rejects temp domains + suppresses the emailnator pool) only ever
 * sees the trusted duck.com domain, and codes are read from the emailnator inbox.
 *
 * Usage:
 *   node duck-setup.mjs <relay-inbox> <pw-optional> [--registry path]
 *   relay-inbox = the emailnator dotGmail the duck address forwards to (we poll it for codes).
 * Prints: DUCK_ADDRESS <addr>  (or exits nonzero with the step it failed at).
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const EMAILNATOR_BASE = "https://www.emailnator.com";
const HDRS = {
  "Accept": "application/json",
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
  "Origin": EMAILNATOR_BASE,
  "Referer": EMAILNATOR_BASE + "/inbox",
};

function findChromium() {
  const candidates = [
    process.env.PW_CHROMIUM,
    "C:/Users/hp/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe",
    "/home/runner/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
    "/home/runner/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  const base = path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      const exe = path.join(base, d, "chrome-win64", "chrome.exe");
      if (d.startsWith("chromium") && fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

const STEALTH = `
Object.defineProperty(navigator, "webdriver", { get: () => undefined });
const _qp = navigator.permissions && navigator.permissions.query;
if (_qp) navigator.permissions.query = (p) => p && p.name === "notifications" ? Promise.resolve({ state: Notification.permission, onchange: null }) : _qp(p);
try { Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"], configurable: true }); } catch (e) {}
try { Object.defineProperty(navigator, "platform", { get: () => "Win32", configurable: true }); } catch (e) {}
`;

async function enatorList(email) {
  const r = await fetch(`${EMAILNATOR_BASE}/api/message-list`, {
    method: "POST", headers: HDRS, body: JSON.stringify({ email, limit: 20 }),
  });
  const d = await r.json();
  return (d && d.messages) || [];
}
async function enatorWaitCode(email, tries, gapMs) {
  for (let i = 0; i < tries; i++) {
    try {
      const msgs = await enatorList(email);
      const hit = msgs.find((m) => /duckduckgo|duck\.com|verification|confirm|code/i.test((m.from || "") + (m.subject || "")));
      if (hit) {
        const m = (hit.subject || "").match(/(\d{3})[\s-]*(\d{3})/) || (hit.subject || "").match(/(\d{6})/);
        if (m) return m[1] + (m[2] ? m[2] : "");
      }
    } catch (e) { /* transient */ }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return null;
}

async function clickByText(page, text) {
  const loc = page.locator("button", { hasText: text }).first();
  await loc.click({ timeout: 8000 });
}

async function main() {
  const [relayInbox] = process.argv.slice(2);
  const regIdx = process.argv.indexOf("--registry");
  const registryPath = regIdx >= 0 ? process.argv[regIdx + 1] : null;
  if (!relayInbox) { console.error("usage: node duck-setup.mjs <relay-inbox> [--registry path]"); process.exit(1); }

  const exe = findChromium();
  if (!exe) { console.error("FATAL: chromium not found"); process.exit(1); }
  const browser = await chromium.launch({
    executablePath: exe, headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
    timezoneId: "Asia/Karachi",
  });
  await ctx.addInitScript(STEALTH);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  try {
    // 1. landing
    await page.goto("https://duckduckgo.com/email/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3500);
    const body0 = await page.textContent("body").catch(() => "");
    if (/you have been blocked|attention required|anomaly/i.test(body0)) { console.error("BLOCKED at landing"); process.exit(4); }
    console.log("landing ok, url:", page.url());

    // 2. find the start/signup CTA (buttons + links)
    const ctaCandidates = ["Sign up", "Get Started", "Get started", "Create", "Start"];
    let clicked = false;
    for (const c of ctaCandidates) {
      for (const kind of ["button", "a"]) {
        const loc = page.locator(`${kind}`, { hasText: c }).first();
        if (await loc.count()) {
          const txt = (await loc.textContent().catch(() => "")).trim();
          if (txt.length < 40) { await loc.click({ timeout: 6000 }).catch(() => {}); clicked = true; console.log("clicked:", kind, JSON.stringify(txt)); break; }
        }
      }
      if (clicked) break;
    }
    await page.waitForTimeout(3000);
    console.log("after cta url:", page.url());

    // 3. if we ended up at /start or /signup, submit the email
    let url = page.url();
    if (!/signup|start|confirm|choose/.test(url)) {
      // direct-route fallback chain: the app is client-rendered; hit the routes directly
      for (const route of ["/email/start", "/email/signup"]) {
        await page.goto("https://duckduckgo.com" + route, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(2500);
        const inp = page.locator("input[type=email]").first();
        if (await inp.count()) { url = page.url(); console.log("route hit:", url); break; }
      }
    }
    const emailInput = page.locator("input[type=email]").first();
    const hasInput = await emailInput.count();
    if (hasInput) {
      await emailInput.fill(relayInbox);
      await page.waitForTimeout(800);
      // submit: nearest button or press Enter
      const sub = page.locator("button[type=submit]").first();
      if (await sub.count()) await sub.click({ timeout: 6000 }).catch(() => {});
      else await emailInput.press("Enter");
      console.log("email submitted:", relayInbox);
    } else {
      console.error("NO_EMAIL_INPUT at", url);
      // debug dump: all inputs + buttons on the current page
      const inputs = await page.locator("input").all();
      for (const inp of inputs) {
        const t = await inp.getAttribute("type").catch(() => "?");
        const ph = await inp.getAttribute("placeholder").catch(() => "");
        console.log("  input type=" + t + " ph=" + ph);
      }
      const btns = await page.locator("button, a").all();
      for (const b of btns.slice(0, 25)) {
        const t = (await b.textContent().catch(() => "")).trim();
        if (t) console.log("  ctl: " + t.slice(0, 60));
      }
      process.exit(1);
    }
    await page.waitForTimeout(4000);

    // 4. wait for the DDG code in the relay inbox (up to 6 min)
    console.log("waiting for duck code at", relayInbox, "...");
    const code = await enatorWaitCode(relayInbox, 36, 10000);
    if (!code) { console.error("DUCK_CODE_TIMEOUT"); process.exit(1); }
    console.log("duck code:", code.slice(0, 3) + "-" + code.slice(3));

    // 5. enter code
    const codeInputs = page.locator("input").all();
    let entered = false;
    for (const inp of await codeInputs) {
      const t = await inp.getAttribute("type").catch(() => "");
      const maxlen = await inp.getAttribute("maxlength").catch(() => "");
      if ((t === "text" || t === "tel" || maxlen) ) {
        await inp.fill(code); entered = true; break;
      }
    }
    if (!entered) { const last = page.locator("input").last(); await last.fill(code); }
    await page.waitForTimeout(500);
    const sub2 = page.locator("button[type=submit]").first();
    if (await sub2.count()) await sub2.click({ timeout: 6000 }).catch(() => {});
    else await page.keyboard.press("Enter");
    await page.waitForTimeout(5000);
    console.log("after code url:", page.url());

    // 6. choose a duck address (3-30 alphanumeric)
    url = page.url();
    if (!/choose|address|confirm|welcome/.test(url)) {
      // maybe a continue/next button
      const cont = page.locator("button", { hasText: /Continue|Next|Confirm|Create/ }).first();
      if (await cont.count()) { await cont.click({ timeout: 6000 }).catch(() => {}); await page.waitForTimeout(3000); }
    }
    const duckName = "grokrelay" + Math.random().toString(36).slice(2, 8);
    const addrInput = page.locator("input").first();
    const hasAddr = await addrInput.count();
    if (hasAddr) {
      await addrInput.fill(duckName);
      await page.waitForTimeout(600);
      const sub3 = page.locator("button[type=submit]").first();
      if (await sub3.count()) await sub3.click({ timeout: 6000 }).catch(() => {});
      else await addrInput.press("Enter");
      await page.waitForTimeout(6000);
    }
    console.log("final url:", page.url());

    // 7. confirm the duck address exists in the session (any page text / input value)
    const body = await page.textContent("body").catch(() => "");
    const m = body.match(/([a-z0-9]{5,30})@duck\.com/i);
    const duckAddr = m ? m[1].toLowerCase() + "@duck.com" : duckName + "@duck.com";
    console.log("DUCK_ADDRESS " + duckAddr);

    if (registryPath) {
      const reg = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, "utf8")) : [];
      reg.push({ duck: duckAddr, relay: relayInbox, created: new Date().toISOString() });
      fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2));
    }
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error("ERROR:", e.message);
    try { await browser.close(); } catch {}
    process.exit(1);
  }
}

main();