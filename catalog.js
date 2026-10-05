// What Kendor sells. Prices are in cedis and are the ONLY source of truth:
// the server never trusts a price sent by the app.
// Sample prices. Replace with your own once you know your supplier's cost.
const NETWORKS = {
  mtn: { name: 'MTN', prefixes: ['024', '025', '053', '054', '055', '059'] },
  telecel: { name: 'Telecel', prefixes: ['020', '050'] },
  airteltigo: { name: 'AirtelTigo', prefixes: ['026', '027', '056', '057'] },
};

const RAW = {
  mtn: [[1, 5.5], [2, 11], [3, 16], [5, 26], [10, 50], [20, 96], [50, 230]],
  telecel: [[1, 5], [2, 10], [3, 15], [5, 24], [10, 46], [20, 90], [50, 215]],
  airteltigo: [[1, 5], [2, 10], [4, 19], [6, 28], [10, 45], [20, 88], [40, 170]],
};

const BUNDLES = [];
for (const network of Object.keys(RAW)) {
  for (const [gb, price] of RAW[network]) {
    BUNDLES.push({
      id: `${network}-${gb}gb`,
      network,
      gb,
      price,
      title: `${gb}GB ${NETWORKS[network].name} data bundle`,
    });
  }
}

const AIRTIME_MIN = 1;
const AIRTIME_MAX = 500;

function listBundles(network) {
  return BUNDLES.filter((b) => !network || b.network === network);
}
function findBundle(id) {
  return BUNDLES.find((b) => b.id === id) || null;
}

module.exports = { NETWORKS, listBundles, findBundle, AIRTIME_MIN, AIRTIME_MAX };
