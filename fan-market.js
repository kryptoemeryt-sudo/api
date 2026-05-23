// Deploy as /api/fan-market.js on Vercel.
// Read-only GeckoTerminal proxy used by fan-token-radar.html for OHLCV analysis.

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'chiliz-chain';

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ''));
}

async function readJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const error = new Error(`GeckoTerminal ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');

  const action = String(req.query.action || '');

  try {
    if (action === 'pool') {
      const token = String(req.query.token || '');
      if (!isAddress(token)) return res.status(400).json({ error: 'Invalid token address' });

      const url = `${GECKO_BASE}/networks/${NETWORK}/tokens/${token}/pools?include=base_token,quote_token&page=1`;
      const json = await readJson(url);
      const pools = Array.isArray(json.data) ? json.data : [];
      const preferred = pools.find(pool => /\/\s*wCHZ/i.test(pool.attributes?.name || '')) || pools[0];
      if (!preferred) return res.status(200).json({ pool: null });
      const baseId = preferred.relationships?.base_token?.data?.id || '';
      const tokenSide = baseId.toLowerCase().endsWith(token.toLowerCase()) ? 'base' : 'quote';

      return res.status(200).json({
        pool: preferred.attributes.address,
        name: preferred.attributes.name,
        tokenSide,
      });
    }

    if (action === 'ohlcv') {
      const pool = String(req.query.pool || '');
      if (!isAddress(pool)) return res.status(400).json({ error: 'Invalid pool address' });

      const before = Math.max(0, Number(req.query.before || Math.floor(Date.now() / 1000)));
      const limit = Math.min(1000, Math.max(24, Number(req.query.limit || 1000)));
      const tokenSide = req.query.tokenSide === 'quote' ? 'quote' : 'base';
      const query = new URLSearchParams({
        aggregate: '1',
        before_timestamp: String(before),
        limit: String(limit),
        currency: 'usd',
        token: tokenSide,
      });
      const json = await readJson(`${GECKO_BASE}/networks/${NETWORK}/pools/${pool}/ohlcv/hour?${query}`);
      return res.status(200).json({
        candles: json.data?.attributes?.ohlcv_list || [],
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    const status = error.status === 429 ? 429 : 502;
    return res.status(status).json({ error: error.message });
  }
};
