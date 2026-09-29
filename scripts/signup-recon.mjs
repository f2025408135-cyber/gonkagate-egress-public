// signup-recon.mjs — validate OAuth/egress targets from the fresh runner IP.
// No secrets, public-safe. Reports: runner IP, captcha walls, geo walls.
const TARGETS = [
  { name: 'github-signup', url: 'https://github.com/signup', want: 'form' },
  { name: 'github-login', url: 'https://github.com/login', want: 'form' },
  { name: 'modal-signup', url: 'https://modal.com/signup', want: 'form' },
  { name: 'lightning-root', url: 'https://lightning.ai/', want: 'any' },
  { name: 'lightning-register', url: 'https://lightning.ai/register', want: 'form' },
];
const CAPTCHA = ['captcha-delivery', 'hcaptcha', 'turnstile', 'recaptcha', 'data-dome', 'captcha'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

async function main() {
  try {
    const ip = await (await fetch('https://api.ipify.org?format=json')).json();
    console.log('RUNNER_IP:', ip.ip);
  } catch (e) { console.log('RUNNER_IP: ERR', e.message); }

  for (const t of TARGETS) {
    try {
      const r = await fetch(t.url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      const html = await r.text();
      const hit = CAPTCHA.filter((c) => html.toLowerCase().includes(c));
      const hasForm = /<form/i.test(html) || /name="login"|login_field|Create account|Continue with GitHub|Sign up for Modal/i.test(html);
      const geo = /Coming soon|hasn't expanded to your area/i.test(html);
      console.log(JSON.stringify({ target: t.name, status: r.status, finalUrl: r.url, captcha: hit, hasForm, geo, len: html.length }));
    } catch (e) {
      console.log(JSON.stringify({ target: t.name, err: e.message.slice(0, 120) }));
    }
  }
}
main();