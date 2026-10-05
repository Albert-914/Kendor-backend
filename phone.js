const { NETWORKS } = require('./catalog');

// "+233 24 123 4567", "0241234567" and "233241234567" all become "0241234567".
function normalize(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('233') && d.length === 12) d = '0' + d.slice(3);
  return d;
}

function isValid(d) {
  return /^0\d{9}$/.test(d);
}

// Which network a number belongs to, from its first three digits. Null if unknown.
function detectNetwork(d) {
  const prefix = d.slice(0, 3);
  for (const key of Object.keys(NETWORKS)) {
    if (NETWORKS[key].prefixes.includes(prefix)) return key;
  }
  return null;
}

function mask(d) {
  return d.length === 10 ? d.slice(0, 3) + ' *** ' + d.slice(7) : '***';
}

module.exports = { normalize, isValid, detectNetwork, mask };
