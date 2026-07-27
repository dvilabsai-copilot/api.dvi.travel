import { PrismaService } from '../../../prisma.service';

type EligibleLikeRow = {
  vendor_id?: number | null;
  vendor_branch_id?: number | null;
  vehicle_type_id?: number | null;
  vendor_vehicle_type_id?: number | null;
  vehicle_id?: number | null;
};

export async function filterActiveVendorCandidateRows<T extends EligibleLikeRow>(
  prisma: PrismaService,
  rows: T[],
): Promise<{
  rows: T[];
  activeVendorIds: Set<number>;
  activeBranchIds: Set<number>;
  activeVehicleIds: Set<number>;
}> {
  const vendorIds = Array.from(
    new Set(rows.map((row) => Number(row?.vendor_id || 0)).filter((id) => id > 0)),
  );
  const branchIds = Array.from(
    new Set(rows.map((row) => Number(row?.vendor_branch_id || 0)).filter((id) => id > 0)),
  );
  const vehicleIds = Array.from(
    new Set(rows.map((row) => Number(row?.vehicle_id || 0)).filter((id) => id > 0)),
  );
  const vendorVehicleTypeIds = Array.from(
    new Set(rows.map((row) => Number(row?.vendor_vehicle_type_id || 0)).filter((id) => id > 0)),
  );

  const [vendors, branches, vehicles, vendorVehicleTypes] = await Promise.all([
    vendorIds.length
      ? prisma.dvi_vendor_details.findMany({
          where: {
            vendor_id: { in: vendorIds } as any,
            status: 1,
            deleted: 0,
          },
          select: { vendor_id: true },
        })
      : Promise.resolve([] as Array<{ vendor_id: number }>),
    branchIds.length
      ? prisma.dvi_vendor_branches.findMany({
          where: {
            vendor_branch_id: { in: branchIds } as any,
            status: 1,
            deleted: 0,
          },
          select: { vendor_branch_id: true, vendor_id: true },
        })
      : Promise.resolve([] as Array<{ vendor_branch_id: number }>),
    vehicleIds.length
      ? prisma.dvi_vehicle.findMany({
          where: {
            vehicle_id: { in: vehicleIds } as any,
            status: 1,
            deleted: 0,
          },
          select: {
            vehicle_id: true,
            vendor_id: true,
            vendor_branch_id: true,
            vehicle_type_id: true,
          },
        })
      : Promise.resolve([] as Array<{ vehicle_id: number }>),
    vendorVehicleTypeIds.length
      ? prisma.dvi_vendor_vehicle_types.findMany({
          where: {
            vendor_vehicle_type_ID: { in: vendorVehicleTypeIds } as any,
            status: 1,
            deleted: 0,
          },
          select: { vendor_vehicle_type_ID: true, vendor_id: true },
        })
      : Promise.resolve([] as Array<{ vendor_vehicle_type_ID: number; vendor_id: number }>),
  ]);

  const activeVendorIds = new Set(vendors.map((row) => Number(row.vendor_id || 0)).filter((id) => id > 0));
  const activeBranchVendorById = new Map(
    branches
      .map((row: any) => [Number(row.vendor_branch_id || 0), Number(row.vendor_id || 0)] as const)
      .filter(([branchId, vendorId]) => branchId > 0 && vendorId > 0),
  );
  const activeBranchIds = new Set(activeBranchVendorById.keys());
  const activeVehicleById = new Map(
    (vehicles as any[])
      .map((row) => [Number(row.vehicle_id || 0), row] as const)
      .filter(([id]) => id > 0),
  );
  const activeVehicleIds = new Set(activeVehicleById.keys());
  const activeVendorVehicleTypeKeys = new Set(
    (vendorVehicleTypes as any[])
      .map((row) => `${Number(row.vendor_id || 0)}_${Number(row.vendor_vehicle_type_ID || 0)}`)
      .filter((key) => !key.startsWith('0_') && !key.endsWith('_0')),
  );

  return {
    rows: rows.filter((row) => {
      const vendorId = Number(row?.vendor_id || 0);
      const branchId = Number(row?.vendor_branch_id || 0);
      const vendorVehicleTypeId = Number(row?.vendor_vehicle_type_id || 0);
      const vehicleId = Number(row?.vehicle_id || 0);
      const vehicle = activeVehicleById.get(vehicleId) as any;
      const vehicleTypeMatches =
        !vehicle || !vendorVehicleTypeId
          ? false
          : Number(vehicle.vehicle_type_id || 0) === vendorVehicleTypeId ||
            Number(vehicle.vehicle_type_id || 0) === Number(row?.vehicle_type_id || 0);

      return (
        vendorId > 0 &&
        branchId > 0 &&
        vendorVehicleTypeId > 0 &&
        vehicleId > 0 &&
        activeVendorIds.has(vendorId) &&
        activeBranchIds.has(branchId) &&
        activeBranchVendorById.get(branchId) === vendorId &&
        activeVendorVehicleTypeKeys.has(`${vendorId}_${vendorVehicleTypeId}`) &&
        activeVehicleIds.has(vehicleId) &&
        Number(vehicle?.vendor_id || 0) === vendorId &&
        Number(vehicle?.vendor_branch_id || 0) === branchId &&
        vehicleTypeMatches
      );
    }),
    activeVendorIds,
    activeBranchIds,
    activeVehicleIds,
  };
}
