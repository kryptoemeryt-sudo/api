// Deploy as /api/solana-proxy.js on Vercel.
// Solana JSON-RPC proxy used by solana-smart-money-radar.html.
// Bypasses browser CORS restrictions by forwarding requests server-side.
//
// Optional env var: HELIUS_API_KEY — set in Vercel dashboard for higher rate limits.
// Without it falls back to the public Solana mainnet RPC.

const RPC_URL = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';

// Methods the frontend is allowed to call (read-only whitelist)
const ALLOWED_METHODS = new Set([
  'getSignaturesForAddress',
  'getTransaction',
  'getTransactions',
  'getAccountInfo',
  'getMultipleAccounts',
  'getParsedAccountInfo',
  'getTokenAccountsByOwner',
  'getTokenSupply',
  'getRecentBlockhash',
  'getLatestBlockhash',
  'getSlot',
  'getBlockTime',
]);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Support single request or batch array
  const requests = Array.isArray(body) ? body : [body];

  // Validate all methods
  for (const rpcReq of requests) {
    const method = String(rpcReq?.method || '');
    if (!ALLOWED_METHODS.has(method)) {
      return res.status(403).json({ error: `Method not allowed: ${method}` });
    }
  }

  try {
    const upstream = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Array.isArray(body) ? requests : requests[0]),
    });

    const data = await upstream.json();

    // Cache aggressive for static historical data, short for latest
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    return res.status(upstream.status).json(data);
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
};
