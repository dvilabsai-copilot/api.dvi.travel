import { PrismaService } from '../../../prisma.service';

type EligibleLikeRow = {
  vendor_id?: number | null;
  vendor_branch_id?: number | null;
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

  const [vendors, branches, vehicles] = await Promise.all([
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
          select: { vendor_branch_id: true },
        })
      : Promise.resolve([] as Array<{ vendor_branch_id: number }>),
    vehicleIds.length
      ? prisma.dvi_vehicle.findMany({
          where: {
            vehicle_id: { in: vehicleIds } as any,
            status: 1,
            deleted: 0,
          },
          select: { vehicle_id: true },
        })
      : Promise.resolve([] as Array<{ vehicle_id: number }>),
  ]);

  const activeVendorIds = new Set(vendors.map((row) => Number(row.vendor_id || 0)).filter((id) => id > 0));
  const activeBranchIds = new Set(
    branches.map((row) => Number(row.vendor_branch_id || 0)).filter((id) => id > 0),
  );
  const activeVehicleIds = new Set(vehicles.map((row) => Number(row.vehicle_id || 0)).filter((id) => id > 0));

  return {
    rows: rows.filter((row) => {
      const vendorId = Number(row?.vendor_id || 0);
      const branchId = Number(row?.vendor_branch_id || 0);
      const vehicleId = Number(row?.vehicle_id || 0);

      return (
        vendorId > 0 &&
        branchId > 0 &&
        vehicleId > 0 &&
        activeVendorIds.has(vendorId) &&
        activeBranchIds.has(branchId) &&
        activeVehicleIds.has(vehicleId)
      );
    }),
    activeVendorIds,
    activeBranchIds,
    activeVehicleIds,
  };
}
