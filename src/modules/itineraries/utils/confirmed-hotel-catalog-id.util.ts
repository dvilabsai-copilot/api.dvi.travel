type ConfirmedHotelIdentity = {
  hotel_id?: number | null;
  hotel_code?: string | null;
  hotel_provider?: string | null;
};

export function getConfirmedHotelCatalogId(hotel?: ConfirmedHotelIdentity): number {
  const storedId = Number(hotel?.hotel_id || 0);
  if (storedId > 0) return storedId;
  if (String(hotel?.hotel_provider || '').trim().toLowerCase() !== 'offline') return 0;

  // Legacy offline selections saved the canonical dvi_hotel ID as their code.
  const code = String(hotel?.hotel_code || '').trim();
  const id = Number(code);
  return /^\d+$/.test(code) && id > 0 && id <= 2_147_483_647 ? id : 0;
}
