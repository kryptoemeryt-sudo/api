// Deploy as /api/solana-proxy.js on Vercel.
// Routes to Solscan public REST API (no credits, no RPC limits).
// Optional env: HELIUS_API_KEY for faster parseTransactions path.

const SOLSCAN_BASE = 'https://public-api.solscan.io';
const HELIUS_KEY   = process.env.HELIUS_API_KEY || '';

async function solscanGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${SOLSCAN_BASE}${path}${qs ? '?' + qs : ''}`;
  const resp = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'block-kickers-radar/1.0',
    },
  });
  if (resp.status === 429) { const e = new Error('rate_limited'); e.status = 429; throw e; }
  if (!resp.ok) { const e = new Error(`Solscan ${resp.status}`); e.status = resp.status; throw e; }
  return resp.json();
}

async function heliusParsed(signatures) {
  if (!HELIUS_KEY) return null;
  const url = `https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactions: signatures.slice(0, 100) }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return Array.isArray(data) ? data : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = {};
  if (req.method === 'POST') {
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
    catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  // Merge GET params and POST body into one params object
  const p = { ...req.query, ...body };
  const action = String(p.action || '');

  try {
    // ── 1. Token transfer list (replaces getSignaturesForAddress) ──────────────
    // Returns list of transfer signatures for a token mint.
    // action=transfers&mint=<mint>&offset=0&limit=50
    if (action === 'transfers') {
      const mint   = String(p.mint   || '');
      const offset = Math.max(0, Number(p.offset || 0));
      const limit  = Math.min(50, Math.max(10, Number(p.limit || 50)));
      if (!mint) return res.status(400).json({ error: 'mint required' });

      const data = await solscanGet('/token/transfer', { tokenAddress: mint, offset, limit });
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
      return res.status(200).json({ transfers: Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []) });
    }

    // ── 2. Single transaction detail ──────────────────────────────────────────
    // action=tx&sig=<signature>
    if (action === 'tx') {
      const sig = String(p.sig || '');
      if (!sig) return res.status(400).json({ error: 'sig required' });

      const data = await solscanGet(`/transaction/${sig}`);
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.status(200).json({ tx: data });
    }

    // ── 3. Wallet token transactions ──────────────────────────────────────────
    // action=wallet&address=<address>&mint=<mint>&offset=0&limit=50
    if (action === 'wallet') {
      const address = String(p.address || '');
      const mint    = String(p.mint    || '');
      const offset  = Math.max(0, Number(p.offset || 0));
      const limit   = Math.min(50, Math.max(10, Number(p.limit || 50)));
      if (!address) return res.status(400).json({ error: 'address required' });

      const params = { account: address, offset, limit };
      if (mint) params.tokenAddress = mint;
      const data = await solscanGet('/account/token/txs', params);
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
      return res.status(200).json({ txs: Array.isArray(data.data) ? data.data : [] });
    }

    // ── 4. Batch parse via Helius (optional, when key is set) ─────────────────
    // action=parse&signatures=[...]
    if (action === 'parse') {
      const sigs = Array.isArray(p.signatures) ? p.signatures : [];
      if (!sigs.length) return res.status(200).json({ transactions: [] });
      const result = await heliusParsed(sigs);
      if (!result) return res.status(200).json({ transactions: [], noKey: true });
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.status(200).json({ transactions: result });
    }

    // ── 5. Token holders top list ─────────────────────────────────────────────
    // action=holders&mint=<mint>&limit=20
    if (action === 'holders') {
      const mint  = String(p.mint  || '');
      const limit = Math.min(20, Number(p.limit || 20));
      if (!mint) return res.status(400).json({ error: 'mint required' });

      const data = await solscanGet('/token/holders', { tokenAddress: mint, offset: 0, limit });
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
      return res.status(200).json({ holders: Array.isArray(data.data) ? data.data : [] });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    const status = err.status === 429 ? 429 : 502;
    return res.status(status).json({ error: err.message });
  }
};
