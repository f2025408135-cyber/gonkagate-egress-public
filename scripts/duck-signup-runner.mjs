#!/usr/bin/env node
/**
 * duck-signup-runner.mjs — DDG Email Protection signup on a GH Actions runner (fresh IP).
 * One session: handshake → advance → choose-address → review → captcha (Gemini describe solver)
 * → submit → dump session state (cookies/localStorage + extension chrome.storage) + try generating
 * addresses → ENCRYPT result envelope (AES-256-GCM + RSA-4096 ddg-public.pem) → scripts/duck-result-<RUN>.json.enc
 *
 * Emits ciphertext only. Local side decrypts with private/ddg-private.pem.
 * Env: DUCKNAME, DDGFWD, GEMINI_KEYS (comma-sep), RUN_ID
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, randomBytes, publicEncrypt, constants } from 'node:crypto';

const EXT = path.resolve('ddg-ext');
const PROFILE = path.resolve('duck-profile-runner');
const TILEDIR = path.resolve('tmp/tiles');
const DUCKNAME = process.env.DUCKNAME || ('relay' + Math.random().toString(36).slice(2, 7));
const FWD = process.env.DDGFWD || 'anonysusarchiver@gmail.com';
const RUN_ID = process.env.RUN_ID || String(Date.now());
const OUT_ENC = path.resolve(`scripts/duck-result-${RUN_ID}.json.enc`);
const OUT_KEY = path.resolve(`scripts/duck-result-${RUN_ID}.json.key`);
const PUB_PEM = fs.readFileSync(path.resolve('ddg-public.pem'), 'utf8');
fs.mkdirSync(TILEDIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const result = { ok: false, reason: null, duckname: DUCKNAME, duckAddr: DUCKNAME + '@duck.com', fwd: FWD, runner: RUN_ID, at: new Date().toISOString() };

// --- Gemini describe lane ---
const RAW_KEYS = (process.env.GEMINI_KEYS || '').replace(/["'\r]/g, '');
const KEYS = RAW_KEYS.split(',').map(s => s.trim()).filter(Boolean);
const MODELS = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-2.5-flash'];
log('gemini keys:', KEYS.length);
async function describe(file, promptText) {
  const b64 = fs.readFileSync(file).toString('base64');
  for (let round = 0; round < 2; round++) {
    for (const key of KEYS) {
      for (const model of MODELS) {
        try {
          const body = { contents: [{ role: 'user', parts: [{ text: promptText || 'Describe this image in 5-10 words: name the main subject(s) plainly. If there is any duck (duck, duckling, mallard, duck head), be sure to say "duck". No extra commentary.' }, { inlineData: { mimeType: 'image/jpeg', data: b64 } }] }], generationConfig: { temperature: 0, maxOutputTokens: 400 } };
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
          const t = await r.text();
          if (!r.ok) { log(`  describe ${model} k..${key.slice(-4)} ${r.status}`); continue; }
          const j = JSON.parse(t);
          const out = ((j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('') || '').trim();
          if (out) return out.replace(/\s+/g, ' ');
        } catch (e) { log('  describe err', String(e.message).slice(0, 70)); }
      }
    }
    await new Promise(r => setTimeout(r, 20000));
  }
  return null;
}
const isDuck = (desc) => /\bducks?\b|\bducklings?\b|\bmallards?\b/i.test(desc || '');

function encryptEnvelope(plaintext) {
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encKey = publicEncrypt({ key: PUB_PEM, padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.concat([aesKey, iv, tag]));
  fs.writeFileSync(OUT_ENC, ct);
  fs.writeFileSync(OUT_KEY, encKey);
  log('ENCRYPTED ->', path.basename(OUT_ENC), ct.length, 'bytes');
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  viewport: { width: 1280, height: 900 },
});
await ctx.addInitScript(`Object.defineProperty(navigator,'webdriver',{get:()=>undefined});`);
const page = ctx.pages()[0] || await ctx.newPage();
page.setDefaultTimeout(25000);
const state = async () => await page.evaluate(() => ({ url: location.href, body: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 800) })).catch(e => ({ err: String(e).slice(0, 100) }));
const fullBody = async () => await page.evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ')).catch(() => '');
const shotB64 = async (p) => { try { const b = await page.screenshot({ timeout: 15000 }); return b.toString('base64'); } catch { return null; } };
const grab = async (name) => { try { return { name, b64: await shotB64() }; } catch { return null; } };

try {
  log('launch ok, url=', page.url());
  await page.goto('https://duckduckgo.com/email/start', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // landing block check
  let body0 = ''; try { body0 = await page.textContent('body') || ''; } catch {}
  if (/you have been blocked|attention required|access denied|anomaly in the request/i.test(body0)) {
    result.reason = 'ip-blocked-at-landing'; result.lastState = await state();
    result.shots = [await grab('blocked')].filter(Boolean);
    throw new Error('ip-blocked-at-landing');
  }

  // extension-handshake ready loop
  let ready = false;
  for (let i = 0; i < 10; i++) {
    const body = (await page.textContent('body').catch(() => '')) || '';
    if (!/requires the DuckDuckGo extension/i.test(body)) { ready = true; break; }
    log('gate present, reload', i);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(5000);
  }
  log('ready:', ready);
  if (!ready) { result.reason = 'ext-gate-stuck'; result.lastState = await state(); result.shots = [await grab('gate')].filter(Boolean); throw new Error('ext-gate-stuck'); }

  // advance to choose-address
  for (let i = 0; i < 10 && !/choose-address|review/.test(page.url()); i++) {
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button, a')].find(x => /^(next|continue|agree|accept|got it|start|get started)$/i.test((x.innerText || '').trim()));
      if (!b) return null; b.click(); return (b.innerText || '').trim();
    }).catch(() => null);
    log('advance:', clicked, page.url());
    if (!clicked) break;
    await page.waitForTimeout(3500);
  }

  if (/choose-address/.test(page.url())) {
    await page.locator('input').nth(0).fill(DUCKNAME).catch(() => {});
    await page.locator('input').nth(1).fill(FWD).catch(() => {});
    await page.waitForTimeout(500);
    const cont = page.locator('a, button').filter({ hasText: /^Continue$/ }).first();
    if (await cont.count()) await cont.click(); else await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);
  }
  const afterChoose = await state();
  log('after choose:', JSON.stringify(afterChoose));
  result.lastState = afterChoose;
  if (/patience please/i.test(afterChoose.body || '')) {
    result.reason = 'throttled-patience';
    result.shots = [await grab('patience')].filter(Boolean);
    throw new Error('throttled-patience');
  }
  if (/one-time passphrase|check your inbox/i.test(afterChoose.body || '')) {
    result.reason = 'email-passphrase-variant';
    try { result.storageState = await ctx.storageState().catch(() => null); } catch {}
    result.shots = [await grab('passphrase-screen')].filter(Boolean);
    throw new Error('email-passphrase-variant');
  }

  if (/\/email\/review/.test(page.url())) {
    await page.evaluate(() => { const b = [...document.querySelectorAll('a,button')].find(x => /this is correct/i.test((x.innerText || '').trim())); if (b) b.click(); }).catch(() => {});
    await page.waitForTimeout(6500);
  }
  const afterConfirm = await state();
  log('after confirm:', JSON.stringify(afterConfirm));
  result.lastState = afterConfirm;
  if (/patience please/i.test(afterConfirm.body || '')) {
    result.reason = 'throttled-patience-at-review';
    result.shots = [await grab('patience2')].filter(Boolean);
    throw new Error('throttled-patience');
  }

  // --- captcha loop (up to 4 rounds) ---
  for (let round = 0; round < 4; round++) {
    let n = await page.evaluate(() => document.querySelectorAll('input[name="selectedTiles[]"]').length).catch(() => 0);
    if (!n) {
      // a failed round shows a "Try again" gate before the next puzzle appears
      const clickedTry = await page.evaluate(() => { const b = [...document.querySelectorAll('button,a')].find(x => /^try again$/i.test((x.innerText || '').trim())); if (b) { b.click(); return true; } return false; }).catch(() => false);
      if (clickedTry) {
        log('clicked Try again');
        await page.waitForTimeout(6500);
        n = await page.evaluate(() => document.querySelectorAll('input[name="selectedTiles[]"]').length).catch(() => 0);
      }
      if (!n) { log('no captcha tiles — moving on'); break; }
    }
    log('captcha round', round, 'tiles', n);
    const tiles = await page.evaluate(() => [...document.querySelectorAll('input[name="selectedTiles[]"]')].map(cb => { const lab = cb.closest('label'); const img = lab ? lab.querySelector('img') : null; return { val: cb.value, src: img ? img.src : null }; }));
    const ducks = [];
    let unknown = 0;
    const verdicts = {};
    for (let i = 0; i < tiles.length; i++) {
      const md5 = tiles[i].val;
      const dest = path.join(TILEDIR, md5 + '.jpg');
      if (!fs.existsSync(dest) && tiles[i].src) {
        try { const r = await fetch(tiles[i].src); fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer())); } catch (e) { log('download err', String(e).slice(0, 60)); }
      }
      let v = null;
      if (fs.existsSync(dest)) {
        const desc = await describe(dest);
        log(`tile ${i + 1} ${md5.slice(0, 8)}: ${desc}`);
        if (desc) {
          v = isDuck(desc) ? 'duck' : 'notduck';
          if (v === 'duck') {
            const c = await describe(dest, 'Answer with exactly one word, yes or no: does this image contain a duck (any duck, duckling or duck head)?');
            log(`  confirm ${md5.slice(0, 8)}: ${c}`);
            if (c && /^\s*no\b/i.test(c.trim())) v = 'notduck';
          }
        }
      }
      if (v) verdicts[i + 1] = v;
      if (!v) { unknown++; continue; }
      if (v === 'duck') ducks.push(i + 1);
    }
    log('DUCKS:', JSON.stringify(ducks), 'unknown:', unknown);
    result.verdicts = verdicts;
    if (unknown > 0) {
      result.reason = 'unknown-tiles';
      result.shots = [await grab('unknown-tiles')].filter(Boolean);
      throw new Error('unknown-tiles');
    }
    await page.evaluate((tiles) => {
      const cbs = [...document.querySelectorAll('input[name="selectedTiles[]"]')];
      cbs.forEach((cb, i) => { const want = tiles.includes(i + 1); if (cb.checked !== want) cb.click(); });
    }, ducks);
    await page.waitForTimeout(600);
    await page.evaluate(() => { const b = [...document.querySelectorAll('button,a,input')].find(x => /^submit$/i.test((x.innerText || x.value || '').trim())); if (b) b.click(); }).catch(() => {});
    await page.waitForTimeout(10000);
    const afterSubmit = await state();
    log('after submit:', JSON.stringify(afterSubmit));
    result.lastState = afterSubmit;
    result.shots = [await grab('after-submit')].filter(Boolean);
    if (/patience please/i.test(afterSubmit.body || '')) { result.reason = 'throttled-after-captcha'; throw new Error('throttled-after-captcha'); }
    if (!/bot|puzzle|try again/i.test(afterSubmit.body || '')) break;
  }

  await page.waitForTimeout(6000);
  const fin = await state();
  log('FINAL:', JSON.stringify(fin));
  result.finalState = fin;
  // success = POSITIVE signal and no failure text anywhere
  const blob = (fin.url || '') + ' ' + (fin.body || '');
  const bad = /choose-address|patience please|try again|not quite right|attempts? left|bot|puzzle/i.test(blob);
  const ok = !bad && (/welcome|settings|complete|success/i.test(fin.url || '') || /@duck\.com/i.test(fin.body || ''));
  result.ok = ok;
  result.reason = ok ? 'success' : (result.reason || 'did-not-advance');

  if (ok) {
    // dump browser storage
    try { result.storageState = await ctx.storageState(); } catch (e) { log('storageState err', String(e).slice(0, 80)); }
    // extension service worker storage
    try {
      let sw = ctx.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
      if (!sw) { const w = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null); if (w && w.url().startsWith('chrome-extension://')) sw = w; }
      if (sw) {
        result.swUrl = sw.url();
        result.extStorage = await sw.evaluate(() => new Promise((res) => chrome.storage.local.get(null, (v) => res(v))));
        log('extStorage keys:', Object.keys(result.extStorage || {}).join(','));
        try { result.extSync = await sw.evaluate(() => new Promise((res) => chrome.storage.sync.get(null, (v) => res(v)))); log('extSync keys:', Object.keys(result.extSync || {}).join(',')); } catch {}
      } else { log('no service worker found'); }
    } catch (e) { log('sw err', String(e).slice(0, 120)); }

    // try address generation on settings page
    try {
      await page.goto('https://duckduckgo.com/email/settings', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(7000);
      const s0 = await state();
      log('settings:', JSON.stringify(s0).slice(0, 400));
      const s0txt = await fullBody();
      result.settingsText = s0txt.slice(0, 5000);
      const addrs = new Set((s0txt.match(/[a-z0-9]{5,30}@duck\.com/gi) || []).map(a => a.toLowerCase()));
      // click generate-like buttons up to 8 times
      for (let i = 0; i < 8; i++) {
        const clicked = await page.evaluate(() => {
          const b = [...document.querySelectorAll('button, a, [role=button]')].find(x => /generate|new (duck )?address|create.*address|get.*address/i.test((x.innerText || '').trim()));
          if (!b) return null; b.click(); return (b.innerText || '').trim().slice(0, 60);
        }).catch(() => null);
        if (!clicked) break;
        log('gen click:', clicked);
        await page.waitForTimeout(3500);
        const s = await fullBody();
        for (const a of (s.match(/[a-z0-9]{5,30}@duck\.com/gi) || [])) addrs.add(a.toLowerCase());
      }
      result.generated = [...addrs];
      log('addresses seen:', result.generated.length);
      result.shots = [...(result.shots || []), await grab('final')].filter(Boolean);
    } catch (e) { log('settings/gen err', String(e).slice(0, 120)); }
  }
} catch (e) {
  log('ERROR:', String(e).slice(0, 200));
  if (!result.reason) result.reason = 'exception:' + String(e).slice(0, 120);
  if (!result.shots) result.shots = [await grab('error')].filter(Boolean);
}

try { encryptEnvelope(JSON.stringify(result)); }
catch (e) { log('ENCRYPT FAIL:', String(e).slice(0, 200)); }
try { await ctx.close(); } catch {}
log('done ok=' + result.ok + ' reason=' + result.reason);
process.exit(0);
