export function catalogProvider(value = '0fiat') {
  if (!['0fiat', 'cryptorefills'].includes(value)) throw Error('Invalid catalog provider');
  return value;
}
const categories = {
  shopping: /amazon|walmart|target|ikea|adidas|nike|fashion|hardware|department|flipkart|myntra/i,
  food: /restaurant|food|pizza|burger|coffee|starbucks|dunkin|dining|grill|doordash|ubereats|zomato|swiggy|pub|subway/i,
  gaming: /game|gaming|steam|playstation|xbox|nintendo|roblox|razer/i,
  travel: /travel|hotel|airbnb|airalo|flight|airline|uber|lyft|booking|cruise/i,
};
export function cleanCatalog(vouchers) {
  const byId = new Map();
  for (const v of vouchers) {
    if (
      !Number.isSafeInteger(v.voucherId) ||
      !v.brandName ||
      !v.currency ||
      !v.countryCode ||
      !['FIXED', 'FLEXIBLE'].includes(v.denominationMode)
    )
      throw Error('Invalid catalog record');
    const old = byId.get(v.voucherId);
    if (old && JSON.stringify(old) !== JSON.stringify(v))
      throw Error('Conflicting catalog records');
    byId.set(v.voucherId, v);
  }
  return [...byId.values()];
}
export function catalogPage(vouchers, { country, search = '', category = '', offset = 0 }) {
  const groups = new Map();
  for (const v of vouchers) {
    if (
      v.countryCode !== country ||
      (search && !`${v.name} ${v.brandName}`.toLowerCase().includes(search.toLowerCase())) ||
      (categories[category] && !categories[category].test(v.name + ' ' + v.brandName))
    )
      continue;
    const safe = ({
      voucherId,
      name,
      brandName,
      iconUrl,
      countryCode,
      currency,
      denominationMode,
      denominations,
      minAmount,
      maxAmount,
    }) => ({
      voucherId,
      name,
      brandName,
      iconUrl,
      countryCode,
      currency,
      denominationMode,
      denominations: denominations ?? [],
      minAmount,
      maxAmount,
    });
    const k = v.brandName.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') + '|' + v.currency;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(safe(v));
  }
  const items = [...groups.values()].map((variants) => {
    variants.sort(
      (a, b) =>
        (a.denominationMode === 'FLEXIBLE' ? 0 : 1) - (b.denominationMode === 'FLEXIBLE' ? 0 : 1) ||
        Number(a.minAmount) - Number(b.minAmount),
    );
    return { ...variants[0], variants };
  });
  return {
    countries: [...new Set(vouchers.map((v) => v.countryCode))].sort(),
    total: items.length,
    items: items.slice(offset, offset + 36),
  };
}
