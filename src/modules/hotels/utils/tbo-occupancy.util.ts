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

/** Split validated occupancies using a caller-provided supplier request limit. */
export const splitTboRoomOccupancies = (
  occupancies: readonly TboRoomOccupancy[],
  maxRoomsPerRequest: number,
): TboRoomOccupancy[][] => {
  if (!Number.isSafeInteger(maxRoomsPerRequest) || maxRoomsPerRequest < 1) {
    throw new RangeError('Invalid supplier room limit');
  }

  if (!Array.isArray(occupancies) || occupancies.length === 0) {
    throw new RangeError('Room occupancies are required');
  }

  const batches: TboRoomOccupancy[][] = [];
  for (let index = 0; index < occupancies.length; index += maxRoomsPerRequest) {
    batches.push(
      occupancies.slice(index, index + maxRoomsPerRequest).map((room) => ({
        ...room,
        childrenAges: room.childrenAges ? [...room.childrenAges] : undefined,
      })),
    );
  }
  return batches;
};

export type TboRoomBatch = {
  batchIndex: number;
  startRoomIndex: number;
  roomCount: number;
  guestCount: number;
  occupancies: TboRoomOccupancy[];
};

export const buildTboRoomBatches = (
  occupancies: readonly TboRoomOccupancy[],
  maxRoomsPerRequest: number,
): TboRoomBatch[] => {
  const groups = splitTboRoomOccupancies(
    occupancies,
    maxRoomsPerRequest,
  );

  let startRoomIndex = 0;

  return groups.map((group, batchIndex) => {
    const batch: TboRoomBatch = {
      batchIndex,
      startRoomIndex,
      roomCount: group.length,
      guestCount: group.reduce(
        (sum, room) => sum + room.adults + room.children,
        0,
      ),
      occupancies: group,
    };

    startRoomIndex += group.length;
    return batch;
  });
};
