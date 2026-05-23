// Deploy as /api/solana-proxy.js on Vercel.
// Solana RPC + Helius Enhanced API proxy for solana-smart-money-radar.html.
//
// Env vars (Vercel Dashboard → Settings → Environment Variables):
//   HELIUS_API_KEY  — free at helius.dev, enables fast parseTransactions endpoint
//
// Without HELIUS_API_KEY falls back to api.mainnet-beta.solana.com (slower, ~2 req/s safe).

const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const RPC_URL    = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : 'https://api.mainnet-beta.solana.com';
const HELIUS_ENHANCED = `https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_KEY}`;

const ALLOWED_RPC = new Set([
  'getSignaturesForAddress',
  'getTransaction',
  'getTransactions',
  'getAccountInfo',
  'getMultipleAccounts',
  'getTokenSupply',
  'getLatestBlockhash',
  'getSlot',
]);

// In-memory cache (lives for the lifetime of this serverless instance, ~seconds to minutes)
const cache = new Map();
const CACHE_TTL = 60_000; // 60s for historical tx data
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value) {
  if (cache.size > 500) {
    // evict oldest
    const oldest = [...cache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { value, ts: Date.now() });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  // ── Helius Enhanced: parse multiple transactions at once ─────────────────────
  // Called with { action: 'parseTransactions', signatures: [...] }
  if (body?.action === 'parseTransactions') {
    if (!HELIUS_KEY) {
      return res.status(200).json({ error: 'no_helius_key', transactions: [] });
    }
    const sigs = Array.isArray(body.signatures) ? body.signatures.slice(0, 100) : [];
    if (!sigs.length) return res.status(200).json({ transactions: [] });

    const cacheKey = 'ptx:' + sigs.slice(0,3).join(',') + sigs.length;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cached);
    }

    try {
      const upstream = await fetch(HELIUS_ENHANCED, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: sigs }),
      });
      if (upstream.status === 429) return res.status(429).json({ error: 'rate_limited' });
      const data = await upstream.json();
      const result = { transactions: Array.isArray(data) ? data : [] };
      cacheSet(cacheKey, result);
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.status(200).json(result);
    } catch (e) {
      return res.status(502).json({ error: e.message, transactions: [] });
    }
  }

  // ── Standard JSON-RPC proxy ──────────────────────────────────────────────────
  const requests = Array.isArray(body) ? body : [body];
  for (const r of requests) {
    if (!ALLOWED_RPC.has(String(r?.method || '')))
      return res.status(403).json({ error: `Method not allowed: ${r?.method}` });
  }

  // Cache key for read-only idempotent calls
  const cacheKey = JSON.stringify(body);
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(cached);
  }

  try {
    const upstream = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Array.isArray(body) ? requests : requests[0]),
    });
    if (upstream.status === 429) return res.status(429).json({ error: 'rate_limited' });
    const data = await upstream.json();
    cacheSet(cacheKey, data);
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(upstream.ok ? 200 : upstream.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
