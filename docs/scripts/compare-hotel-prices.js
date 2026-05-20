const API_BASE = "http://127.0.0.1:4006/api/v1";

const STAY_BLOCKS = [
  { cityCode: "Ooty", checkInDate: "2026-04-29", checkOutDate: "2026-05-01", label: "Ooty (2N)" },
  { cityCode: "Kodaikanal", checkInDate: "2026-05-01", checkOutDate: "2026-05-03", label: "Kodaikanal (2N)" },
];

const currentPax = {
  roomCount: 1,
  guestCount: 5,
  adultCount: 3,
  childCount: 2,
  childAges: [8, 8],
  guestNationality: "IN",
  providers: ["tbo", "resavenue"],
};

const singleAdult = {
  roomCount: 1,
  guestCount: 1,
  adultCount: 1,
  childCount: 0,
  childAges: [],
  guestNationality: "IN",
  providers: ["tbo", "resavenue"],
};

async function searchHotels(payload) {
  const res = await fetch(`${API_BASE}/hotels/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json?.data?.hotels || [];
}

function minPrice(hotels) {
  if (!hotels.length) return null;
  return hotels.reduce((min, h) => Math.min(min, Number(h.price || 0)), Number.POSITIVE_INFINITY);
}

function mapByHotelNameMinPrice(hotels) {
  const out = new Map();
  for (const h of hotels) {
    const key = String(h.hotelName || "").trim().toLowerCase();
    if (!key) continue;
    const p = Number(h.price || 0);
    if (!out.has(key) || p < out.get(key).price) {
      out.set(key, { name: h.hotelName, price: p, provider: h.provider || "" });
    }
  }
  return out;
}

function toInr(n) {
  if (n == null || Number.isNaN(Number(n))) return "N/A";
  return `INR ${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

(async () => {
  console.log("Hotel price comparison: current pax vs single adult\n");

  for (const block of STAY_BLOCKS) {
    const base = {
      cityCode: block.cityCode,
      checkInDate: block.checkInDate,
      checkOutDate: block.checkOutDate,
    };

    const currentHotels = await searchHotels({ ...base, ...currentPax });
    const singleHotels = await searchHotels({ ...base, ...singleAdult });

    const currentMin = minPrice(currentHotels);
    const singleMin = minPrice(singleHotels);

    console.log(`=== ${block.label} ===`);
    console.log(`Current pax results: ${currentHotels.length}, min: ${toInr(currentMin)}`);
    console.log(`Single adult results: ${singleHotels.length}, min: ${toInr(singleMin)}`);

    if (currentMin != null && singleMin != null) {
      const delta = currentMin - singleMin;
      const pct = singleMin > 0 ? (delta / singleMin) * 100 : 0;
      console.log(`Min-price delta (current - single): ${toInr(delta)} (${pct.toFixed(2)}%)`);
    }

    const currentMap = mapByHotelNameMinPrice(currentHotels);
    const singleMap = mapByHotelNameMinPrice(singleHotels);
    const common = [];

    for (const [k, c] of currentMap.entries()) {
      const s = singleMap.get(k);
      if (!s) continue;
      common.push({
        hotel: c.name,
        current: c.price,
        single: s.price,
        delta: c.price - s.price,
      });
    }

    common.sort((a, b) => a.delta - b.delta);

    if (common.length) {
      console.log(`Common hotels compared: ${common.length}`);
      console.log("Sample deltas (up to 5 hotels):");
      common.slice(0, 5).forEach((r) => {
        console.log(
          `- ${r.hotel}: current=${toInr(r.current)}, single=${toInr(r.single)}, delta=${toInr(r.delta)}`,
        );
      });
    } else {
      console.log("No common hotel names between both searches for direct row-to-row delta.");
    }

    console.log("");
  }
})().catch((err) => {
  console.error("Comparison failed:", err.message);
  process.exit(1);
});
