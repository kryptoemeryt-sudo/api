// api/events.js â€” Vercel Serverless Function
// Cachuje eventy FigureMinted + Listed + Sold z blockchaina
// Vercel Edge Cache trzyma odpowiedĹş 5 minut â€” RPC odpytywane raz, nie per user

const { ethers } = require("ethers");

const CONTRACT_ADDRESS = "0xAAdc8D56e25a223B6cf4b88ba0889975560f21aB";
const MARKET_ADDRESS   = "0xA18f7Bade67Eda41FD7D2B3A204d39b543977DaE";
const DEPLOY_BLOCK     = 34086621;
const CHUNK            = 20000;

const RPC_URLS = [
  "https://chiliz-rpc.publicnode.com",
  "https://rpc.chiliz.com",
  "https://chiliz.drpc.org"
];

const ABI = [
  "function totalMinted() external view returns (uint256)",
  "event FigureMinted(address indexed owner, uint256 indexed tokenId, uint256 dna, uint256 teamId, uint256 position, uint8 rarity, uint256 weight)"
];

const MARKET_ABI = [
  "event Listed(uint256 indexed listingId, address indexed seller, uint256 tokenId, uint256 price)",
  "event Sold(uint256 indexed listingId, address indexed buyer, uint256 price)"
];

async function getProvider() {
  for (const url of RPC_URLS) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      await p.getBlockNumber();
      return p;
    } catch(e) {}
  }
  throw new Error("All RPC endpoints failed");
}

async function fetchEventRange(contract, filter, fromBlock, toBlock) {
  try {
    return await contract.queryFilter(filter, fromBlock, toBlock);
  } catch (e) {
    if (fromBlock >= toBlock) return [];
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const [left, right] = await Promise.all([
      fetchEventRange(contract, filter, fromBlock, mid),
      fetchEventRange(contract, filter, mid + 1, toBlock),
    ]);
    return [...left, ...right];
  }
}

async function fetchAllEvents(contract, filter, fromBlock, toBlock) {
  const ranges = [];
  for (let b = fromBlock; b <= toBlock; b += CHUNK) {
    ranges.push([b, Math.min(b + CHUNK - 1, toBlock)]);
  }
  const chunks = await Promise.all(ranges.map(([from, to]) => fetchEventRange(contract, filter, from, to)));
  return chunks.flat();
}

module.exports = async function handler(req, res) {
  // Vercel Edge Cache â€” wszyscy userzy dostajÄ… ten sam wynik przez 5 minut
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const provider = await getProvider();
    const currentBlock = await provider.getBlockNumber();

    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
    const market   = new ethers.Contract(MARKET_ADDRESS, MARKET_ABI, provider);

    // Pobierz wszystkie eventy rĂłwnolegle
    const [mintEvs, listedEvs, soldEvs] = await Promise.all([
      fetchAllEvents(contract, contract.filters.FigureMinted(), DEPLOY_BLOCK, currentBlock),
      fetchAllEvents(market,   market.filters.Listed(),         DEPLOY_BLOCK, currentBlock),
      fetchAllEvents(market,   market.filters.Sold(),           DEPLOY_BLOCK, currentBlock),
    ]);

    // Mapuj listingId â†’ tokenId z Listed eventĂłw
    const listingToToken = {};
    const listingToSeller = {};
    const listingToPrice = {};
    listedEvs.forEach(ev => {
      const listingId = Number(ev.args.listingId);
      listingToToken[listingId] = Number(ev.args.tokenId);
      listingToSeller[listingId] = ev.args.seller.toLowerCase();
      listingToPrice[listingId] = ev.args.price.toString();
    });

    // Serializuj â€” BigInt nie jest JSON-serializable
    const mints = mintEvs.map(ev => ({
      tokenId: Number(ev.args.tokenId),
      owner:   ev.args.owner.toLowerCase(),
      dna:     ev.args.dna.toString(),
      block:   Number(ev.blockNumber),
    }));

    const sales = soldEvs.map(ev => ({
      listingId: Number(ev.args.listingId),
      tokenId:   listingToToken[Number(ev.args.listingId)] ?? null,
      buyer:     ev.args.buyer.toLowerCase(),
      seller:    listingToSeller[Number(ev.args.listingId)] ?? null,
      price:     listingToPrice[Number(ev.args.listingId)] ?? ev.args.price.toString(),
      block:     Number(ev.blockNumber),
    })).filter(s => s.tokenId !== null);

    const listings = listedEvs.map(ev => ({
      listingId: Number(ev.args.listingId),
      tokenId:   Number(ev.args.tokenId),
      seller:    ev.args.seller.toLowerCase(),
      price:     ev.args.price.toString(),
      block:     Number(ev.blockNumber),
    }));

    res.status(200).json({
      currentBlock,
      mints,
      sales,
      listings,
      fetchedAt: Date.now(),
    });

  } catch(err) {
    console.error("api/events error:", err);
    res.status(500).json({ error: err.message });
  }
}
