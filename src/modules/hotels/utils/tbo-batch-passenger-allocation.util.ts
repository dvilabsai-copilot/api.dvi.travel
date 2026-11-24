
export interface TboBatchPassenger {
  paxType: number;
  age: number;
}

export interface TboBatchRoomOccupancy {
  adults: number;
  children: number;
  childrenAges?: number[];
}

export interface TboPassengerBatch {
  batchIndex: number;
  startRoomIndex: number;
  roomCount: number;
}

export function allocateTboBatchPassengers<T extends TboBatchPassenger>(
  passengers: T[],
  occupancies: TboBatchRoomOccupancy[],
  roomPassengerIndices: number[][],
  batches: TboPassengerBatch[],
): Array<{
  batchIndex: number;
  roomCount: number;
  occupancies: TboBatchRoomOccupancy[];
  passengers: T[];
}> {
  if (
    !Array.isArray(passengers) ||
    !Array.isArray(occupancies) ||
    !Array.isArray(roomPassengerIndices) ||
    !Array.isArray(batches) ||
    occupancies.length === 0 ||
    batches.length === 0 ||
    roomPassengerIndices.length !== occupancies.length
  ) {
    throw new Error('Invalid TBO passenger allocation input.');
  }

  const assignedPassengers = new Set<number>();
  const coveredRooms = new Set<number>();
  const usedBatchIndices = new Set<number>();

  const rooms = occupancies.map((occupancy, roomIndex) => {
    const indices = roomPassengerIndices[roomIndex];

    if (!Array.isArray(indices)) {
      throw new Error(`Missing passengers for room ${roomIndex + 1}.`);
    }

    if (
      !Number.isInteger(occupancy.adults) ||
      occupancy.adults < 1 ||
      !Number.isInteger(occupancy.children) ||
      occupancy.children < 0
    ) {
      throw new Error(`Invalid occupancy for room ${roomIndex + 1}.`);
    }

    if (indices.length !== occupancy.adults + occupancy.children) {
      throw new Error(`Passenger count mismatch for room ${roomIndex + 1}.`);
    }

    const roomPassengers = indices.map((index) => {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= passengers.length ||
        assignedPassengers.has(index)
      ) {
        throw new Error(`Invalid or duplicated passenger assignment in room ${roomIndex + 1}.`);
      }

      assignedPassengers.add(index);
      return passengers[index];
    });

    const adults = roomPassengers.filter((p) => p.paxType === 1);
    const children = roomPassengers.filter((p) => p.paxType === 2);

    if (
      adults.length !== occupancy.adults ||
      children.length !== occupancy.children
    ) {
      throw new Error(`Passenger types do not match room ${roomIndex + 1}.`);
    }

    const requiredAges = occupancy.childrenAges ?? [];

    if (
      requiredAges.length !== occupancy.children ||
      [...requiredAges].sort((a, b) => a - b).join(',') !==
        children.map((p) => p.age).sort((a, b) => a - b).join(',')
    ) {
      throw new Error(`Child ages do not match room ${roomIndex + 1}.`);
    }

    return roomPassengers;
  });

  if (assignedPassengers.size !== passengers.length) {
    throw new Error('Some passengers were not assigned to a room.');
  }

  const results = batches.map((batch) => {
    const { batchIndex, startRoomIndex, roomCount } = batch;

    if (
      !Number.isInteger(batchIndex) ||
      !Number.isInteger(startRoomIndex) ||
      !Number.isInteger(roomCount) ||
      startRoomIndex < 0 ||
      roomCount < 1 ||
      startRoomIndex + roomCount > rooms.length
    ) {
      throw new Error('Invalid TBO room batch.');
    }

    if (usedBatchIndices.has(batchIndex)) {
      throw new Error(`Duplicate TBO batch index ${batchIndex}.`);
    }

    usedBatchIndices.add(batchIndex);

    for (let i = startRoomIndex; i < startRoomIndex + roomCount; i++) {
      if (coveredRooms.has(i)) {
        throw new Error(`Room ${i + 1} is assigned to multiple batches.`);
      }
      coveredRooms.add(i);
    }

    return {
      batchIndex,
      roomCount,
      occupancies: occupancies.slice(
        startRoomIndex,
        startRoomIndex + roomCount,
      ),
      passengers: rooms
        .slice(startRoomIndex, startRoomIndex + roomCount)
        .flat(),
    };
  });

  if (coveredRooms.size !== rooms.length) {
    throw new Error('Some rooms are missing from TBO batches.');
  }

  return results;
}
