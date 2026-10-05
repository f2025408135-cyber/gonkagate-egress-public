// zai-mint-recon.mjs — fresh-runner-IP probe: z.ai Aliyun captcha scene policy.
// Scenes: 36qgs6xb = auth (signup/signin) embed; didk33e0 = chat completions popup.
// If the auth scene yields a SILENT param from this IP, attempt signup with an emailnator address.
// Public-safe: no secrets.
const SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const SCENES = ["36qgs6xb", "didk33e0"];
const log = (o) => console.log("ZAI_RECON " + JSON.stringify(o));

async function runnerIp() {
  try { const j = await (await fetch("https://api.ipify.org?format=json")).json(); return j.ip } catch (e) { return "ERR:" + e.message }
}

function makeEl(id) {
  const listeners = {};
  const el = {
    id: id || "", tagName: "DIV", style: { cssText: "", setProperty: () => {} },
    className: "", children: [], parentNode: null, innerHTML: "", src: "", type: "",
    setAttribute: () => {}, removeAttribute: () => {},
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn) },
    appendChild: (c) => { c.parentNode = el; return c },
    removeChild: (c) => { c.parentNode = null; return c },
    remove: () => {}, click: () => { (listeners["click"] || []).forEach((f) => f()) },
    contentWindow: { document: { readyState: "complete", open: () => {}, close: () => {}, write: () => {}, documentElement: {} } },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 300, height: 40, right: 300, bottom: 40 }),
    querySelector: () => null,
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
    offsetWidth: 300, offsetHeight: 40, clientWidth: 300, clientHeight: 40,
  };
  Object.defineProperty(el, "onclick", { get() { return listeners["click"] ? listeners["click"][0] : null }, set(f) { listeners["click"] = [f] }, configurable: true });
  return el;
}

function makeWindow(ua) {
  const body = makeEl("__body"), head = makeEl("__head"), els = {};
  const documentStub = {
    createElement: () => makeEl(""), createTextNode: (t) => ({ text: String(t) }),
    querySelector: (sel) => (typeof sel === "string" && sel.startsWith("#") ? els[sel.slice(1)] || null : null),
    getElementById: (id) => els[id] || null, getElementsByTagName: () => [body, head],
    body, head, documentElement: body, cookie: "", readyState: "complete",
    addEventListener: () => {}, removeEventListener: () => {}, write: () => {}, open: () => {}, close: () => {},
    createEvent: () => ({ initCustomEvent: () => {} }),
  };
  els.__body = body; els.__head = head; els.__box = makeEl("__box"); els.__btn = makeEl("__btn");
  body.appendChild(els.__box); body.appendChild(els.__btn);
  const win = {
    document: documentStub,
    navigator: { userAgent: ua, language: "en-US" },
    location: { hostname: "chat.z.ai", protocol: "https:", href: "https://chat.z.ai/auth" },
    setTimeout, clearTimeout, setInterval, clearInterval,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {}, removeEventListener: () => {},
    screen: { width: 1920, height: 1080 }, innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
    history: { pushState: () => {}, replaceState: () => {} },
    AliyunCaptchaConfig: { region: "sgp", prefix: "no8xfe" },
    FEILIN: { initFeiLin: () => {} },
    Event: globalThis.Event || class Event {}, CustomEvent: globalThis.CustomEvent || class CustomEvent {},
  };
  function AliyunCaptcha() {}
  AliyunCaptcha.prototype = { config: {}, deviceConfig: {} };
  win.AliyunCaptcha = AliyunCaptcha;
  return { win, els, documentStub };
}

function makeXHR(captured, ua) {
  function XHRStub() {
    this.headers = {}; this.response = ""; this.responseText = ""; this.status = 0;
    this.timeout = 0; this.responseType = "text"; this.withCredentials = false;
    this.onload = null; this.onerror = null; this.ontimeout = null; this.onreadystatechange = null; this.readyState = 0; this.respHeaders = {};
  }
  XHRStub.prototype.open = function (m, u) { this.method = m; this.url = u; this.readyState = 1 };
  XHRStub.prototype.setRequestHeader = function (k, v) { this.headers[k] = v };
  XHRStub.prototype.getResponseHeader = function (k) { return this.respHeaders[k.toLowerCase()] || null };
  XHRStub.prototype.send = async function (b) {
    this.readyState = 2;
    try {
      const resp = await fetch(this.url, { method: this.method, headers: { ...this.headers, Origin: "https://chat.z.ai", Referer: "https://chat.z.ai/" }, body: b || undefined, redirect: "follow", signal: AbortSignal.timeout(15000) });
      const text = await resp.text();
      captured.push({ url: this.url.slice(0, 120), status: resp.status, resp: text.slice(0, 2000) });
      this.status = resp.status; this.respHeaders = {};
      for (const [k, v] of resp.headers) this.respHeaders[k.toLowerCase()] = v;
      this.response = text; this.responseText = text; this.readyState = 4;
      if (this.onload) this.onload();
    } catch (e) { if (this.onerror) this.onerror(e) }
  };
  return XHRStub;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

async function mintScene(scene, sdkSrc) {
  const captured = [];
  const { win, els, documentStub } = makeWindow(UA);
  const XHRStub = makeXHR(captured, UA);
  globalThis.window = win;
  globalThis.document = documentStub;
  try { globalThis.navigator = win.navigator } catch {}
  try { globalThis.location = win.location } catch {}
  globalThis.XMLHttpRequest = XHRStub;
  globalThis.btoa = win.btoa; globalThis.atob = win.atob;
  globalThis.localStorage = win.localStorage; globalThis.sessionStorage = win.sessionStorage;

  let sdkParam = null;
  const origErr = console.error; console.error = () => {};
  try { eval(sdkSrc) } catch (e) { log({ scene, evalErr: String(e.message).slice(0, 200) }) }
  console.error = origErr;

  const t0 = Date.now();
  try {
    win.initAliyunCaptcha({
      SceneId: scene, prefix: "no8xfe", mode: "embed",
      element: "#__box", button: "#__btn", language: "en", timeout: 10000, delayBeforeSuccess: false,
      success: (e) => { sdkParam = typeof e === "string" ? e : JSON.stringify(e) },
      fail: (e) => log({ scene, sdkFail: String(typeof e === "string" ? e : JSON.stringify(e)).slice(0, 300) }),
      getInstance: () => { try { els.__btn.click() } catch {} },
    });
  } catch (e) { log({ scene, initErr: String(e.message).slice(0, 200) }) }
  try { els.__btn.click() } catch {}

  let initResp = null;
  while (Date.now() - t0 < 25000 && !sdkParam) {
    for (const c of captured) {
      try { const j = JSON.parse(c.resp); if (j.CertifyId || j.CaptchaType) initResp = j } catch {}
    }
    if (initResp?.CaptchaType && !sdkParam && Date.now() - t0 > 8000) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return { scene, captchaType: initResp?.CaptchaType ?? null, success: initResp?.Success ?? null, silent: !!sdkParam, paramHead: sdkParam ? sdkParam.slice(0, 90) : null, ms: Date.now() - t0, xhrCalls: captured.length, param: sdkParam };
}

async function emailnatorEmail() {
  try {
    const r = await fetch("https://www.emailnator.com/api/generate-email", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ ids: [3] }), signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    return j.email || null;
  } catch (e) { log({ emailnatorErr: String(e.message).slice(0, 160) }); return null }
}

async function main() {
  const ip = await runnerIp();
  log({ runnerIp: ip, node: process.version, at: new Date().toISOString() });

  // z.ai reachability + auth config from this IP
  try {
    const r = await fetch("https://chat.z.ai/api/v1/auths/", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    log({ zaiAuths: r.status, bodyHead: t.slice(0, 160) });
  } catch (e) { log({ zaiAuthsErr: String(e.message).slice(0, 160) }) }

  let sdkSrc = null;
  try { sdkSrc = await (await fetch(SDK_URL, { signal: AbortSignal.timeout(30000) })).text() } catch (e) { log({ sdkFetchErr: String(e.message).slice(0, 160) }) }
  if (!sdkSrc) return;
  log({ sdkBytes: sdkSrc.length });

  const results = {};
  for (const scene of SCENES) {
    const r = await mintScene(scene, sdkSrc);
    results[scene] = r;
    log({ mint: { scene: r.scene, captchaType: r.captchaType, success: r.success, silent: r.silent, ms: r.ms, xhr: r.xhrCalls, paramHead: r.paramHead } });
  }

  // if auth scene gave a silent param: try a real signup
  const auth = results["36qgs6xb"];
  if (auth?.silent && auth.param) {
    const email = await emailnatorEmail();
    log({ emailnator: email });
    const H = { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json", Origin: "https://chat.z.ai", Referer: "https://chat.z.ai/auth" };
    const r = await fetch("https://chat.z.ai/api/v1/auths/signup", { method: "POST", headers: H, body: JSON.stringify({ name: "Ava Chen", email: email ?? "zai.probe." + Date.now() + "@gmail.com", password: "kQ7mZ2pW9zR4tY6u", captcha_verify_param: auth.param }) });
    const t = await r.text();
    log({ signup: { http: r.status, body: t.slice(0, 800), email } });
  } else {
    log({ signup: "SKIPPED (no silent param from fresh IP)" });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { log({ fatal: String(e.stack || e.message).slice(0, 500) }); process.exit(0) });
