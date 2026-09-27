// Fresh-IP probe: 1 chat completion per model from a GH Actions runner.
// Prints ONLY status codes + timings (never the key). Key comes from GONKA_PROBE_KEY env.
const key = process.env.GONKA_PROBE_KEY;
if (!key) { console.error('NO GONKA_PROBE_KEY'); process.exit(2); }
const base = 'https://api.gonkagate.com/v1';
const models = ['deepseek-ai/deepseek-v4-flash-0731', 'zai-org/glm-5.3-flash', 'minimaxai/minimax-m2.7'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  // models endpoint first (rate limit headers)
  try {
    const r = await fetch(base + '/models', { headers: { 'Authorization': 'Bearer ' + key } });
    const lim = r.headers.get('x-ratelimit-limit'), rem = r.headers.get('x-ratelimit-remaining');
    console.log(`MODELS HTTP ${r.status} ratelimit=${lim}/${rem}`);
  } catch (e) { console.log('MODELS ERR ' + e.message); }
  for (const m of models) {
    const t0 = Date.now();
    try {
      const r = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'Say PONG' }], max_tokens: 8, stream: false })
      });
      const j = await r.json().catch(() => ({}));
      const dt = Date.now() - t0;
      const ok = j.choices ? 'OK' : (j.error ? j.error.code + ':' + (j.error.message || '').slice(0, 60) : '?');
      const retry = r.headers.get('retry-after');
      console.log(`CHAT ${m} HTTP ${r.status} ${dt}ms ${ok} retry=${retry}`);
    } catch (e) { console.log(`CHAT ${m} ERR ${e.message}`); }
    await sleep(2000);
  }
})();