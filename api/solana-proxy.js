// /api/solana-proxy.js — Vercel serverless proxy
// Forwards requests to GMGN.ai (smart money data) and DexScreener (token info)
// Eliminates CORS issues for browser clients.

const GMGN   = 'https://gmgn.ai';
const DS     = 'https://api.dexscreener.com';

// Allowed upstream paths (whitelist for security)
function getAllowedBase(action) {
  const map = {
    // GMGN — token top traders / smart money
    'gmgn_top_traders':  GMGN,
    'gmgn_wallet_stat':  GMGN,
    'gmgn_wallet_txs':   GMGN,
    'gmgn_token_info':   GMGN,
    'gmgn_trending':     GMGN,
    // DexScreener — token pairs / price
    'ds_pairs':          DS,
    'ds_search':         DS,
  };
  return map[action] || null;
}

function buildPath(action, params) {
  switch(action) {
    // Top traders for a token  → wallet list with PnL + win_rate
    case 'gmgn_top_traders':
      return `/defi/quotation/v1/tokens/top_traders/sol/${params.mint}?orderby=${params.orderby||'profit'}&direction=${params.direction||'desc'}&limit=${params.limit||50}`;
    // Wallet stats (PnL, win rate, 30d summary)
    case 'gmgn_wallet_stat':
      return `/api/v1/wallet_stat/sol/${params.wallet}?period=${params.period||'30d'}`;
    // Wallet recent transactions
    case 'gmgn_wallet_txs':
      return `/api/v1/wallet_activity/sol?wallet=${params.wallet}&limit=${params.limit||20}`;
    // Token info (security, holders)
    case 'gmgn_token_info':
      return `/api/v1/mutil_window_token_link_info/sol?token_address=${params.mint}`;
    // Trending tokens
    case 'gmgn_trending':
      return `/defi/quotation/v1/rank/sol/swaps/${params.period||'1h'}?orderby=${params.orderby||'swaps'}&direction=desc&limit=20`;
    // DexScreener token pairs
    case 'ds_pairs':
      return `/token-pairs/v1/solana/${params.mint}`;
    case 'ds_search':
      return `/latest/dex/search?q=${encodeURIComponent(params.q||'')}`;
    default: return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = String(req.query.action || '');
  const base   = getAllowedBase(action);
  if (!base) return res.status(400).json({ error: 'Unknown action' });

  const path = buildPath(action, req.query);
  if (!path) return res.status(400).json({ error: 'Bad params' });

  try {
    const upstream = await fetch(base + path, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; block-kickers/1.0)',
        'Referer': 'https://gmgn.ai/',
      }
    });
    const text = await upstream.text();
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.setHeader('Content-Type', 'application/json');
    return res.status(upstream.ok ? 200 : upstream.status).send(text);
  } catch(e) {
    return res.status(502).json({ error: e.message });
  }
};
