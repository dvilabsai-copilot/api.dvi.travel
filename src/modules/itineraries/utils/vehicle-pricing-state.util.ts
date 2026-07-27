export type VehiclePricingStateStatus = 'READY' | 'FAILED' | 'NOT_REQUIRED' | 'RECOVERY_REQUIRED';

export type VehiclePricingState = {
  status: VehiclePricingStateStatus;
  requestedVehicleTypeCount: number;
  usableVehicleDetailCount: number;
  selectedVehicleTypeCount: number;
  requiredSelectionCount: number;
  buildRunId?: string;
  failureReason?: string;
};

export function buildVehiclePricingState(params: {
  requiresVehicles: boolean;
  requestedVehicleTypeIds: Iterable<number>;
  usableVehicleDetailCount: number;
  selectedVehicleTypeIds: Iterable<number>;
  latestBuildStatus?: string | null;
  latestBuildRunId?: string | null;
  latestFailureReason?: string | null;
}): VehiclePricingState {
  const requestedIds = new Set(
    Array.from(params.requestedVehicleTypeIds).map(Number).filter((id) => id > 0),
  );
  const selectedIds = new Set(
    Array.from(params.selectedVehicleTypeIds)
      .map(Number)
      .filter((id) => requestedIds.has(id)),
  );
  const requestedVehicleTypeCount = requestedIds.size;
  const requiredSelectionCount = requestedVehicleTypeCount;
  const usableVehicleDetailCount = Math.max(0, Number(params.usableVehicleDetailCount || 0));
  const selectedVehicleTypeCount = selectedIds.size;
  const buildRunId = String(params.latestBuildRunId || '').trim() || undefined;

  if (!params.requiresVehicles || requestedVehicleTypeCount === 0) {
    return {
      status: 'NOT_REQUIRED',
      requestedVehicleTypeCount: 0,
      usableVehicleDetailCount,
      selectedVehicleTypeCount: 0,
      requiredSelectionCount: 0,
      ...(buildRunId ? { buildRunId } : {}),
    };
  }

  if (
    requestedVehicleTypeCount > 0 &&
    usableVehicleDetailCount > 0 &&
    selectedVehicleTypeCount === requiredSelectionCount
  ) {
    return {
      status: 'READY',
      requestedVehicleTypeCount,
      usableVehicleDetailCount,
      selectedVehicleTypeCount,
      requiredSelectionCount,
      ...(buildRunId ? { buildRunId } : {}),
    };
  }

  const failureReason = String(params.latestFailureReason || '').trim() || (
    selectedVehicleTypeCount < requiredSelectionCount
      ? `Vehicle selection is incomplete (${selectedVehicleTypeCount}/${requiredSelectionCount})`
      : 'Vehicle pricing has no usable persisted detail rows'
  );

  return {
    status: String(params.latestBuildStatus || '').toUpperCase() === 'FAILED' ? 'FAILED' : 'RECOVERY_REQUIRED',
    requestedVehicleTypeCount,
    usableVehicleDetailCount,
    selectedVehicleTypeCount,
    requiredSelectionCount,
    ...(buildRunId ? { buildRunId } : {}),
    failureReason,
  };
}
