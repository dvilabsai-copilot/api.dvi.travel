export type TboRoomOccupancy = {
  adults: number;
  children: number;
  childrenAges?: number[];
};

export const DEFAULT_TBO_CHILD_AGE = 5;

/**
 * Resolve the saved traveller ages exactly once per child. Missing or invalid
 * ages keep the existing TBO default (5) instead of becoming age 0 through
 * Number(null).
 */
export const resolveSavedTboChildAges = (
  travellers: Array<{ traveller_age?: unknown }> = [],
  childCount: number,
): number[] => Array.from({ length: Math.max(0, Math.trunc(Number(childCount) || 0)) }, (_, index) => {
  const rawAge = travellers[index]?.traveller_age;
  const ageText = String(rawAge ?? '').trim();
  const parsedAge = ageText === '' ? Number.NaN : Number(rawAge);
  const age = Math.trunc(parsedAge);
  return Number.isFinite(age) && age >= 0 && age <= 11
    ? age
    : DEFAULT_TBO_CHILD_AGE;
});

/**
 * TBO search allocates adults and children evenly across rooms and applies
 * child ages in traveller order. Hold Book requests must use this same
 * allocation so their PaxRooms match the search that produced the rate.
 */
export const distributeTboSearchOccupancies = (
  roomCount: number,
  adultCount: number,
  childCount: number,
  childAges: number[] = [],
): TboRoomOccupancy[] => {
  const rooms = Math.max(Math.trunc(Number(roomCount) || 1), 1);
  let adultsLeft = Math.max(Math.trunc(Number(adultCount) || 0), 0);
  let childrenLeft = Math.max(Math.trunc(Number(childCount) || 0), 0);
  let childAgeIndex = 0;

  return Array.from({ length: rooms }, (_, index) => {
    const roomsLeft = rooms - index;
    const adults = Math.ceil(adultsLeft / roomsLeft);
    const children = Math.ceil(childrenLeft / roomsLeft);
    const ages = childAges.slice(childAgeIndex, childAgeIndex + children);
    adultsLeft -= adults;
    childrenLeft -= children;
    childAgeIndex += children;

    return {
      adults,
      children,
      childrenAges: ages.length > 0 ? ages : undefined,
    };
  });
};
