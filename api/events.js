// api/events.js — Vercel Serverless Function
// Cachuje eventy FigureMinted + Listed + Sold z blockchaina
// Vercel Edge Cache trzyma odpowiedź 5 minut — RPC odpytywane raz, nie per user

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

async function fetchAllEvents(contract, filter, fromBlock, toBlock) {
  let events = [];
  for (let b = fromBlock; b <= toBlock; b += CHUNK) {
    const to = Math.min(b + CHUNK - 1, toBlock);
    for (const size of [CHUNK, 10000, 5000]) {
      try {
        const chunk = await contract.queryFilter(filter, b, Math.min(b + size - 1, to));
        events = [...events, ...chunk];
        break;
      } catch(e) {}
    }
  }
  return events;
}

export default async function handler(req, res) {
  // Vercel Edge Cache — wszyscy userzy dostają ten sam wynik przez 5 minut
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const provider = await getProvider();
    const currentBlock = await provider.getBlockNumber();

    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
    const market   = new ethers.Contract(MARKET_ADDRESS, MARKET_ABI, provider);

    // Pobierz wszystkie eventy równolegle
    const [mintEvs, listedEvs, soldEvs] = await Promise.all([
      fetchAllEvents(contract, contract.filters.FigureMinted(), DEPLOY_BLOCK, currentBlock),
      fetchAllEvents(market,   market.filters.Listed(),         DEPLOY_BLOCK, currentBlock),
      fetchAllEvents(market,   market.filters.Sold(),           DEPLOY_BLOCK, currentBlock),
    ]);

    // Mapuj listingId → tokenId z Listed eventów
    const listingToToken = {};
    listedEvs.forEach(ev => {
      listingToToken[Number(ev.args.listingId)] = Number(ev.args.tokenId);
    });

    // Serializuj — BigInt nie jest JSON-serializable
    const mints = mintEvs.map(ev => ({
      tokenId: Number(ev.args.tokenId),
      owner:   ev.args.owner.toLowerCase(),
      dna:     ev.args.dna.toString(),
    }));

    const sales = soldEvs.map(ev => ({
      listingId: Number(ev.args.listingId),
      tokenId:   listingToToken[Number(ev.args.listingId)] ?? null,
      buyer:     ev.args.buyer.toLowerCase(),
    })).filter(s => s.tokenId !== null);

    const listings = listedEvs.map(ev => ({
      listingId: Number(ev.args.listingId),
      tokenId:   Number(ev.args.tokenId),
      seller:    ev.args.seller.toLowerCase(),
      price:     ev.args.price.toString(),
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
