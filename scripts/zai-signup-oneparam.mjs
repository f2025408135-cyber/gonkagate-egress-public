// zai-signup-oneparam.mjs — POST a locally-solved captcha param to z.ai signup from the runner IP.
// Env: ZEMAIL, ZPARAM_B64, ZNAME, ZPASS
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const log = (o) => console.log("ZAI_ONEPARAM " + JSON.stringify(o));
const email = process.env.ZEMAIL;
const param = process.env.ZPARAM_B64;
const name = process.env.ZNAME || "Ava Chen";
const pass = process.env.ZPASS || "Qq9Wm4Kx2Zp7Lr8s";

async function main() {
  try { const j = await (await fetch("https://api.ipify.org?format=json")).json(); log({ runnerIp: j.ip }); } catch (e) { log({ ipErr: String(e).slice(0, 100) }); }
  const { createHash } = await import("node:crypto");
  log({ paramLen: param ? param.length : 0, paramHead: param ? param.slice(0, 24) : null, paramTail: param ? param.slice(-16) : null, paramSha: param ? createHash("sha256").update(param).digest("hex").slice(0, 24) : null });
  const H = { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json", Origin: "https://chat.z.ai", Referer: "https://chat.z.ai/auth" };
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await fetch("https://chat.z.ai/api/v1/auths/signup", { method: "POST", headers: H, body: JSON.stringify({ name, email, password: pass, captcha_verify_param: param }) });
      const t = await r.text();
      log({ try: i, http: r.status, body: t.slice(0, 500), email });
      if (r.status === 200) break;
      if (r.status === 429 || /429/.test(t)) {
        const m = t.match(/after (\d+) seconds/);
        const w = m ? Math.min(40, Number(m[1]) + 5) : 25;
        await new Promise(x => setTimeout(x, w * 1000));
        continue;
      }
      break;
    } catch (e) { log({ try: i, exc: String(e).slice(0, 200) }); await new Promise(x => setTimeout(x, 5000)); }
  }
  process.exit(0);
}
main().catch((e) => { log({ fatal: String(e).slice(0, 300) }); process.exit(0); });
