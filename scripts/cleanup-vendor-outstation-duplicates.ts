import fs from 'node:fs';
import path from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DAY_COLUMNS = Array.from({ length: 31 }, (_, index) => `day_${index + 1}` as const);
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const PRICEBOOK_SELECT = {
  vehicle_outstation_price_book_id: true,
  vendor_id: true,
  vendor_branch_id: true,
  vehicle_type_id: true,
  kms_limit_id: true,
  year: true,
  month: true,
  createdby: true,
  createdon: true,
  updatedon: true,
  status: true,
  deleted: true,
  day_1: true,
  day_2: true,
  day_3: true,
  day_4: true,
  day_5: true,
  day_6: true,
  day_7: true,
  day_8: true,
  day_9: true,
  day_10: true,
  day_11: true,
  day_12: true,
  day_13: true,
  day_14: true,
  day_15: true,
  day_16: true,
  day_17: true,
  day_18: true,
  day_19: true,
  day_20: true,
  day_21: true,
  day_22: true,
  day_23: true,
  day_24: true,
  day_25: true,
  day_26: true,
  day_27: true,
  day_28: true,
  day_29: true,
  day_30: true,
  day_31: true,
} satisfies Prisma.dvi_vehicle_outstation_price_bookSelect;

const KMS_LIMIT_SELECT = {
  kms_limit_id: true,
  vendor_id: true,
  vendor_vehicle_type_id: true,
  kms_limit_title: true,
  kms_limit: true,
  createdby: true,
  createdon: true,
  updatedon: true,
  status: true,
  deleted: true,
} satisfies Prisma.dvi_kms_limitSelect;

const VENDOR_VEHICLE_TYPE_SELECT = {
  vendor_vehicle_type_ID: true,
  vendor_id: true,
  vehicle_type_id: true,
  createdby: true,
  createdon: true,
  updatedon: true,
  status: true,
  deleted: true,
} satisfies Prisma.dvi_vendor_vehicle_typesSelect;

type PricebookRow = Prisma.dvi_vehicle_outstation_price_bookGetPayload<{ select: typeof PRICEBOOK_SELECT }>;
type KmsLimitRow = Prisma.dvi_kms_limitGetPayload<{ select: typeof KMS_LIMIT_SELECT }>;
type VendorVehicleTypeRow = Prisma.dvi_vendor_vehicle_typesGetPayload<{ select: typeof VENDOR_VEHICLE_TYPE_SELECT }>;

type CliArgs = {
  apply: boolean;
  vendorId: number | null;
  allVendors: boolean;
  branchId: number | null;
  year: string | null;
  month: string | null;
  dryRun: boolean;
  mergeVendorVehicleTypes: boolean;
};

type VehicleTypeMeta = {
  vendorVehicleTypeId: number;
  baseVehicleTypeId: number;
  baseVehicleTypeTitle: string;
};

type BranchMeta = {
  vendor_branch_id: number;
  vendor_branch_name: string | null;
};

type DuplicateVendorVehicleTypeGroup = {
  key: string;
  vendorId: number;
  baseVehicleTypeId: number;
  baseVehicleTypeTitle: string;
  canonicalVendorVehicleTypeId: number;
  duplicateVendorVehicleTypeIds: number[];
  rows: VendorVehicleTypeRow[];
};

type DuplicateKmsGroup = {
  key: string;
  vendorId: number;
  vendorVehicleTypeId: number;
  baseVehicleTypeId: number;
  baseVehicleTypeTitle: string;
  normalizedKm: number;
  canonicalKmsLimitId: number;
  duplicateKmsLimitIds: number[];
  rows: KmsLimitRow[];
};

type ExactPricebookGroup = {
  key: string;
  vendorId: number;
  vendorBranchId: number;
  vendorBranchName: string | null;
  vehicleTypeId: number;
  baseVehicleTypeId: number;
  baseVehicleTypeTitle: string;
  kmsLimitId: number;
  kmsLimitTitle: string;
  year: string;
  month: string;
  rowIds: number[];
  rows: PricebookRow[];
};

type MergedDaySource = {
  day: string;
  rowId: number | null;
  value: number | null;
};

type MonthlyMergePlan = {
  key: string;
  vendorId: number;
  vendorBranchId: number;
  vendorBranchName: string | null;
  vehicleTypeId: number;
  baseVehicleTypeId: number;
  baseVehicleTypeTitle: string;
  canonicalKmsLimitId: number;
  sourceKmsLimitIds: number[];
  year: string;
  month: string;
  keeperRowId: number;
  keeperInitialKmsLimitId: number;
  rowIdsInGroup: number[];
  duplicateRowIdsToSoftDelete: number[];
  keeperNeedsUpdate: boolean;
  dayChanges: Array<{ day: string; before: number | null; after: number | null; sourceRowId: number | null }>;
  mergedDays: Record<string, number | null>;
  mergedDaySources: MergedDaySource[];
};

type ExactDuplicateMergePlan = {
  key: string;
  vendorId: number;
  vendorBranchId: number;
  vendorBranchName: string | null;
  vehicleTypeId: number;
  baseVehicleTypeId: number;
  baseVehicleTypeTitle: string;
  kmsLimitId: number;
  kmsLimitTitle: string;
  year: string;
  month: string;
  keeperRowId: number;
  rowIdsInGroup: number[];
  duplicateRowIdsToSoftDelete: number[];
  keeperNeedsUpdate: boolean;
  dayChanges: Array<{ day: string; before: number | null; after: number | null; sourceRowId: number | null }>;
  mergedDays: Record<string, number | null>;
  mergedDaySources: MergedDaySource[];
};

type DeletedKmsLimitNormalizationPlan = {
  key: string;
  vendorId: number;
  vendorVehicleTypeId: number;
  baseVehicleTypeId: number;
  baseVehicleTypeTitle: string;
  normalizedKm: number;
  keptRowId: number;
  keptDeletedValue: number;
  rowIdsInGroup: number[];
  reassignedRows: Array<{ kmsLimitId: number; fromDeleted: number; toDeleted: number }>;
};

type DeletedPricebookNormalizationPlan = {
  key: string;
  vendorId: number;
  vendorBranchId: number;
  vendorBranchName: string | null;
  vehicleTypeId: number;
  baseVehicleTypeId: number;
  baseVehicleTypeTitle: string;
  kmsLimitId: number;
  kmsLimitTitle: string;
  year: string;
  month: string;
  keptRowId: number;
  keptDeletedValue: number;
  rowIdsInGroup: number[];
  reassignedRows: Array<{ pricebookId: number; fromDeleted: number; toDeleted: number }>;
};

type KmsMergePlan = {
  groupKey: string;
  vendorId: number;
  vendorVehicleTypeId: number;
  baseVehicleTypeId: number;
  baseVehicleTypeTitle: string;
  normalizedKm: number;
  canonicalKmsLimitId: number;
  duplicateKmsLimitIds: number[];
  matchingMonthlyGroupCount: number;
  monthlyPlans: MonthlyMergePlan[];
  currentDuplicateReferenceCounts: Record<number, number>;
  plannedRemainingDuplicateReferenceCounts: Record<number, number>;
  duplicateKmsLimitIdsSafeToSoftDelete: number[];
  duplicateKmsLimitIdsBlockedByRemainingReferences: Array<{ kmsLimitId: number; remainingActiveReferences: number }>;
  orphanDuplicateKmsLimitIdsSafeToSoftDelete: number[];
};

type StalePricebookReferenceGroup = {
  key: string;
  vendorId: number;
  vendorBranchId: number;
  vendorBranchName: string | null;
  vehicleTypeId: number;
  kmsLimitId: number;
  year: string;
  month: string;
  rowIds: number[];
  staleReasons: string[];
  rows: PricebookRow[];
};

type StaleReferenceRepairPlan = {
  key: string;
  vendorId: number;
  vendorBranchId: number;
  vendorBranchName: string | null;
  year: string;
  month: string;
  sourceVehicleTypeId: number;
  sourceKmsLimitId: number;
  targetVehicleTypeId: number;
  targetBaseVehicleTypeId: number;
  targetBaseVehicleTypeTitle: string;
  targetKmsLimitId: number | null;
  softDeleteOnly: boolean;
  softDeleteReason: string | null;
  createKmsLimitIfMissing: boolean;
  createKmsLimitPayload: { vendor_vehicle_type_id: number; kms_limit_title: string; kms_limit: number } | null;
  normalizedKm: number;
  staleReasons: string[];
  rowIdsInGroup: number[];
  keeperRowId: number;
  duplicateRowIdsToSoftDelete: number[];
  keeperNeedsUpdate: boolean;
  mergedDays: Record<string, number | null>;
  mergedDaySources: MergedDaySource[];
  dayChanges: Array<{ day: string; before: number | null; after: number | null; sourceRowId: number | null }>;
};

type CleanupPlan = {
  kmsMergePlans: KmsMergePlan[];
  exactDuplicatePricebookPlans: ExactDuplicateMergePlan[];
  deletedKmsLimitNormalizationPlans: DeletedKmsLimitNormalizationPlan[];
  deletedPricebookNormalizationPlans: DeletedPricebookNormalizationPlan[];
  staleReferenceRepairPlans: StaleReferenceRepairPlan[];
  vendorVehicleTypeDuplicateGroups: DuplicateVendorVehicleTypeGroup[];
};

type AuditSnapshot = {
  generatedAt: string;
  filters: {
    vendorId: number | null;
    allVendors: boolean;
    branchId: number | null;
    year: string | null;
    month: string | null;
  };
  counts: {
    vendorVehicleTypeRows: number;
    kmsLimitRows: number;
    pricebookRowsInScope: number;
    duplicateVendorVehicleTypeGroups: number;
    duplicateKmsGroups: number;
    exactDuplicatePricebookGroups: number;
    deletedKmsLimitDuplicateGroups: number;
    deletedPricebookDuplicateGroups: number;
    stalePricebookReferenceGroups: number;
  };
  duplicateVendorVehicleTypeGroups: DuplicateVendorVehicleTypeGroup[];
  duplicateKmsGroups: DuplicateKmsGroup[];
  exactDuplicatePricebookGroups: ExactPricebookGroup[];
  deletedKmsLimitNormalizationPlans: DeletedKmsLimitNormalizationPlan[];
  deletedPricebookNormalizationPlans: DeletedPricebookNormalizationPlan[];
  stalePricebookReferenceGroups: StalePricebookReferenceGroup[];
  verification: {
    duplicateKmsReferenceCounts: Array<{
      groupKey: string;
      canonicalKmsLimitId: number;
      duplicateKmsLimitId: number;
      activePricebookReferences: number;
    }>;
  };
};

type Summary = {
  mode: 'dry-run' | 'apply';
  vendorId: number | null;
  allVendors: boolean;
  branchId: number | null;
  year: string | null;
  month: string | null;
  mergeVendorVehicleTypes: boolean;
  outputDirectory: string;
  files: Record<string, string>;
  countsBefore: AuditSnapshot['counts'];
  countsAfter: AuditSnapshot['counts'];
  actionsPlanned: {
    kmsMergeGroups: number;
    monthlyPricebookGroupsWithinKmsMerges: number;
    exactDuplicatePricebookGroups: number;
    deletedKmsLimitDuplicateGroups: number;
    deletedPricebookDuplicateGroups: number;
    staleReferenceRepairGroups: number;
    pricebookRowsToUpdate: number;
    pricebookRowsToSoftDelete: number;
    kmsLimitRowsToSoftDelete: number;
    kmsLimitRowsToCreate: number;
    deletedKmsLimitRowsToRetag: number;
    deletedPricebookRowsToRetag: number;
    vendorVehicleTypeDuplicateGroups: number;
  };
  actionsApplied: {
    pricebookRowsUpdated: number;
    pricebookRowsSoftDeleted: number;
    kmsLimitRowsSoftDeleted: number;
    kmsLimitRowsCreated: number;
    deletedKmsLimitRowsRetagged: number;
    deletedPricebookRowsRetagged: number;
  };
  skipped: {
    kmsGroupsWithoutScopedPricebooks: number;
    duplicateKmsLimitRowsBlockedByReferences: number;
    unresolvedStaleReferenceGroups: number;
    vendorVehicleTypeMergeSkipped: boolean;
  };
  notes: string[];
};

function usage() {
  console.log('Usage: npx tsx scripts/cleanup-vendor-outstation-duplicates.ts (--vendorId=60 | --allVendors) [--branchId=68] [--year=2026] [--month=6] [--dryRun|--apply]');
  console.log('');
  console.log('Production-safe cleanup for duplicate vendor outstation pricebook data.');
  console.log('');
  console.log('Options:');
  console.log('  --vendorId <id>                  Optional vendor id scope.');
  console.log('  --allVendors                     Scan and clean all vendors.');
  console.log('  --branchId <id>                  Optional vendor branch scope.');
  console.log('  --year <yyyy>                    Optional year scope.');
  console.log('  --month <1-12|MonthName>         Optional month scope.');
  console.log('  --dryRun                         Dry-run only. This is the default.');
  console.log('  --apply                          Execute updates and soft deletes.');
  console.log('  --mergeVendorVehicleTypes        Reserved for future safe merge support. Currently audit-only.');
  console.log('  --help                           Show this help text.');
  console.log('');
  console.log('Apply mode also requires ALLOW_PROD_DB_CLEANUP=true.');
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    const stripped = token.slice(2);
    const eqIndex = stripped.indexOf('=');
    if (eqIndex >= 0) {
      const key = stripped.slice(0, eqIndex);
      const value = stripped.slice(eqIndex + 1);
      out[key] = value === '' ? true : value;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      out[stripped] = true;
      continue;
    }

    out[stripped] = next;
    index += 1;
  }

  return out;
}

function toPositiveInt(value: string | boolean | undefined, flagName: string): number | null {
  if (value === undefined || value === false) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${flagName}. Expected a positive integer.`);
  }
  return parsed;
}

function normalizeMonth(value: string | boolean | undefined): string | null {
  if (value === undefined || value === false) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= 12) {
    return MONTH_NAMES[asNumber - 1];
  }

  const normalized = raw.toLowerCase();
  const found = MONTH_NAMES.find((month) => month.toLowerCase() === normalized);
  if (!found) {
    throw new Error(`Invalid --month value: ${raw}. Use 1-12 or full month name.`);
  }

  return found;
}

function normalizeArgs(raw: Record<string, string | boolean>): CliArgs {
  if (raw.help) {
    usage();
    process.exit(0);
  }

  const vendorId = toPositiveInt(raw.vendorId, 'vendorId');
  const allVendors = Boolean(raw.allVendors);
  if (!vendorId && !allVendors) {
    throw new Error('Provide either --vendorId or --allVendors.');
  }
  if (vendorId && allVendors) {
    throw new Error('Use either --vendorId or --allVendors, not both.');
  }
  if (allVendors && raw.branchId) {
    throw new Error('--branchId cannot be combined with --allVendors.');
  }

  const yearValue = raw.year;
  let year: string | null = null;
  if (yearValue !== undefined && yearValue !== false) {
    const numericYear = Number(yearValue);
    if (!Number.isInteger(numericYear) || numericYear < 2000 || numericYear > 9999) {
      throw new Error(`Invalid --year value: ${String(yearValue)}.`);
    }
    year = String(numericYear);
  }

  const apply = Boolean(raw.apply);
  const dryRun = apply ? false : true;

  if (apply && process.env.ALLOW_PROD_DB_CLEANUP !== 'true') {
    throw new Error('Apply mode requires ALLOW_PROD_DB_CLEANUP=true.');
  }

  return {
    apply,
    vendorId,
    allVendors,
    branchId: toPositiveInt(raw.branchId, 'branchId'),
    year,
    month: normalizeMonth(raw.month),
    dryRun,
    mergeVendorVehicleTypes: Boolean(raw.mergeVendorVehicleTypes),
  };
}

function compareRecencyDesc(a: Pick<PricebookRow, 'updatedon' | 'createdon' | 'vehicle_outstation_price_book_id'>, b: Pick<PricebookRow, 'updatedon' | 'createdon' | 'vehicle_outstation_price_book_id'>): number {
  const aUpdated = a.updatedon ? new Date(a.updatedon).getTime() : 0;
  const bUpdated = b.updatedon ? new Date(b.updatedon).getTime() : 0;
  if (aUpdated !== bUpdated) return bUpdated - aUpdated;

  const aCreated = a.createdon ? new Date(a.createdon).getTime() : 0;
  const bCreated = b.createdon ? new Date(b.createdon).getTime() : 0;
  if (aCreated !== bCreated) return bCreated - aCreated;

  return b.vehicle_outstation_price_book_id - a.vehicle_outstation_price_book_id;
}

function isValidPrice(value: unknown): boolean {
  return Number(value || 0) > 0;
}

function normalizePrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function normalizeKmValue(row: Pick<KmsLimitRow, 'kms_limit' | 'kms_limit_title'>): number {
  const direct = Number(row.kms_limit || 0);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const match = String(row.kms_limit_title || '').match(/(\d+(?:\.\d+)?)/);
  const fromTitle = match ? Number(match[1]) : 0;
  return Number.isFinite(fromTitle) ? fromTitle : 0;
}

function getScopedPricebookWhere(args: CliArgs): Prisma.dvi_vehicle_outstation_price_bookWhereInput {
  return {
    ...(args.vendorId ? { vendor_id: args.vendorId } : {}),
    deleted: 0,
    ...(args.branchId ? { vendor_branch_id: args.branchId } : {}),
    ...(args.year ? { year: args.year } : {}),
    ...(args.month ? { month: args.month } : {}),
  };
}

async function ensureOutputDirectory(args: CliArgs): Promise<{ outputDirectory: string; baseLabel: string }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const monthSegment = args.year && args.month
    ? `${args.year}-${String(MONTH_NAMES.indexOf(args.month as typeof MONTH_NAMES[number]) + 1).padStart(2, '0')}`
    : 'all-periods';
  const scopeLabel = args.allVendors ? 'all-vendors' : `vendor-${args.vendorId}`;
  const baseLabel = `${scopeLabel}-${monthSegment}`;
  const outputDirectory = path.join(
    process.cwd(),
    'storage',
    'cleanup-audits',
    'vendor-outstation',
    `${baseLabel}-${timestamp}`,
  );

  fs.mkdirSync(outputDirectory, { recursive: true });
  return { outputDirectory, baseLabel };
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function loadMeta(
  vendorVehicleTypes: VendorVehicleTypeRow[],
  pricebooks: PricebookRow[],
): Promise<{
  vehicleMetaMap: Map<number, VehicleTypeMeta>;
  branchMetaMap: Map<number, BranchMeta>;
}> {
  const baseVehicleTypeIds = [...new Set(vendorVehicleTypes.map((row) => row.vehicle_type_id).filter((value) => value > 0))];
  const branches = [...new Set(pricebooks.map((row) => row.vendor_branch_id).filter((value) => value > 0))];

  const [vehicleTypes, branchRows] = await Promise.all([
    baseVehicleTypeIds.length
      ? prisma.dvi_vehicle_type.findMany({
          where: { vehicle_type_id: { in: baseVehicleTypeIds } },
          select: { vehicle_type_id: true, vehicle_type_title: true },
        })
      : Promise.resolve([]),
    branches.length
      ? prisma.dvi_vendor_branches.findMany({
          where: { vendor_branch_id: { in: branches } },
          select: { vendor_branch_id: true, vendor_branch_name: true },
        })
      : Promise.resolve([]),
  ]);

  const vehicleTitleMap = new Map(
    vehicleTypes.map((row) => [row.vehicle_type_id, String(row.vehicle_type_title || '').trim() || String(row.vehicle_type_id)]),
  );

  const vehicleMetaMap = new Map<number, VehicleTypeMeta>();
  for (const row of vendorVehicleTypes) {
    vehicleMetaMap.set(row.vendor_vehicle_type_ID, {
      vendorVehicleTypeId: row.vendor_vehicle_type_ID,
      baseVehicleTypeId: row.vehicle_type_id,
      baseVehicleTypeTitle: vehicleTitleMap.get(row.vehicle_type_id) ?? String(row.vehicle_type_id),
    });
  }

  const branchMetaMap = new Map<number, BranchMeta>(
    branchRows.map((row) => [
      row.vendor_branch_id,
      {
        vendor_branch_id: row.vendor_branch_id,
        vendor_branch_name: row.vendor_branch_name ?? null,
      },
    ]),
  );

  return { vehicleMetaMap, branchMetaMap };
}

function groupDuplicateVendorVehicleTypes(
  vendorVehicleTypes: VendorVehicleTypeRow[],
  vehicleMetaMap: Map<number, VehicleTypeMeta>,
): DuplicateVendorVehicleTypeGroup[] {
  const groups = new Map<string, VendorVehicleTypeRow[]>();

  for (const row of vendorVehicleTypes) {
    const key = `${row.vendor_id}|${row.vehicle_type_id}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  return Array.from(groups.entries())
    .map(([key, rows]) => ({ key, rows: rows.sort((a, b) => a.vendor_vehicle_type_ID - b.vendor_vehicle_type_ID) }))
    .filter((entry) => entry.rows.length > 1)
    .map((entry) => {
      const [vendorIdRaw, baseVehicleTypeIdRaw] = entry.key.split('|');
      const baseVehicleTypeId = Number(baseVehicleTypeIdRaw);
      const matchingMeta = Array.from(vehicleMetaMap.values()).find((meta) => meta.baseVehicleTypeId === baseVehicleTypeId);
      return {
        key: entry.key,
        vendorId: Number(vendorIdRaw),
        baseVehicleTypeId,
        baseVehicleTypeTitle: matchingMeta?.baseVehicleTypeTitle ?? String(baseVehicleTypeId),
        canonicalVendorVehicleTypeId: entry.rows[0].vendor_vehicle_type_ID,
        duplicateVendorVehicleTypeIds: entry.rows.slice(1).map((row) => row.vendor_vehicle_type_ID),
        rows: entry.rows,
      };
    });
}

function groupDuplicateKmsLimits(
  kmsLimits: KmsLimitRow[],
  vehicleMetaMap: Map<number, VehicleTypeMeta>,
): DuplicateKmsGroup[] {
  const groups = new Map<string, KmsLimitRow[]>();

  for (const row of kmsLimits) {
    const normalizedKm = normalizeKmValue(row);
    const key = `${row.vendor_id}|${row.vendor_vehicle_type_id}|${normalizedKm}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  return Array.from(groups.entries())
    .map(([key, rows]) => ({ key, rows: rows.sort((a, b) => a.kms_limit_id - b.kms_limit_id) }))
    .filter((entry) => entry.rows.length > 1)
    .map((entry) => {
      const first = entry.rows[0];
      const vehicleMeta = vehicleMetaMap.get(first.vendor_vehicle_type_id);
      return {
        key: entry.key,
        vendorId: first.vendor_id,
        vendorVehicleTypeId: first.vendor_vehicle_type_id,
        baseVehicleTypeId: vehicleMeta?.baseVehicleTypeId ?? first.vendor_vehicle_type_id,
        baseVehicleTypeTitle: vehicleMeta?.baseVehicleTypeTitle ?? String(first.vendor_vehicle_type_id),
        normalizedKm: normalizeKmValue(first),
        canonicalKmsLimitId: first.kms_limit_id,
        duplicateKmsLimitIds: entry.rows.slice(1).map((row) => row.kms_limit_id),
        rows: entry.rows,
      };
    });
}

function groupExactDuplicatePricebooks(
  pricebooks: PricebookRow[],
  vehicleMetaMap: Map<number, VehicleTypeMeta>,
  branchMetaMap: Map<number, BranchMeta>,
  kmsLimitMap: Map<number, KmsLimitRow>,
): ExactPricebookGroup[] {
  const groups = new Map<string, PricebookRow[]>();

  for (const row of pricebooks) {
    const key = [
      row.vendor_id,
      row.vendor_branch_id,
      row.vehicle_type_id,
      row.kms_limit_id,
      row.year ?? '',
      row.month ?? '',
    ].join('|');
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  return Array.from(groups.entries())
    .map(([key, rows]) => ({ key, rows: rows.sort(compareRecencyDesc) }))
    .filter((entry) => entry.rows.length > 1)
    .map((entry) => {
      const first = entry.rows[0];
      const vehicleMeta = vehicleMetaMap.get(first.vehicle_type_id);
      const branchMeta = branchMetaMap.get(first.vendor_branch_id);
      const kmsLimit = kmsLimitMap.get(first.kms_limit_id);
      return {
        key: entry.key,
        vendorId: first.vendor_id,
        vendorBranchId: first.vendor_branch_id,
        vendorBranchName: branchMeta?.vendor_branch_name ?? null,
        vehicleTypeId: first.vehicle_type_id,
        baseVehicleTypeId: vehicleMeta?.baseVehicleTypeId ?? first.vehicle_type_id,
        baseVehicleTypeTitle: vehicleMeta?.baseVehicleTypeTitle ?? String(first.vehicle_type_id),
        kmsLimitId: first.kms_limit_id,
        kmsLimitTitle: String(kmsLimit?.kms_limit_title || '').trim() || String(first.kms_limit_id),
        year: String(first.year ?? ''),
        month: String(first.month ?? ''),
        rowIds: entry.rows.map((row) => row.vehicle_outstation_price_book_id),
        rows: entry.rows,
      };
    });
}

function buildDeletedKmsLimitNormalizationPlans(
  allKmsLimits: KmsLimitRow[],
  vehicleMetaMap: Map<number, VehicleTypeMeta>,
): DeletedKmsLimitNormalizationPlan[] {
  const naturalGroups = new Map<string, KmsLimitRow[]>();

  for (const row of allKmsLimits) {
    const normalizedKm = normalizeKmValue(row);
    const key = `${row.vendor_id}|${row.vendor_vehicle_type_id}|${normalizedKm}`;
    const list = naturalGroups.get(key) ?? [];
    list.push(row);
    naturalGroups.set(key, list);
  }

  const plans: DeletedKmsLimitNormalizationPlan[] = [];

  for (const [key, rows] of naturalGroups.entries()) {
    const duplicateDeletedRows = rows.filter((row) => Number(row.deleted || 0) > 0);
    if (duplicateDeletedRows.length < 2) continue;

    const byDeletedValue = new Map<number, KmsLimitRow[]>();
    for (const row of duplicateDeletedRows) {
      const deletedValue = Number(row.deleted || 0);
      const list = byDeletedValue.get(deletedValue) ?? [];
      list.push(row);
      byDeletedValue.set(deletedValue, list);
    }

    if (![...byDeletedValue.values()].some((items) => items.length > 1)) continue;

    let nextDeletedValue = Math.max(...rows.map((row) => Number(row.deleted || 0)), 1) + 1;
    const reassignedRows: Array<{ kmsLimitId: number; fromDeleted: number; toDeleted: number }> = [];
    let keptRowId = 0;
    let keptDeletedValue = 1;

    for (const [deletedValue, items] of [...byDeletedValue.entries()].sort((a, b) => a[0] - b[0])) {
      const sorted = [...items].sort((a, b) => a.kms_limit_id - b.kms_limit_id);
      keptRowId = keptRowId || sorted[0].kms_limit_id;
      keptDeletedValue = keptRowId === sorted[0].kms_limit_id ? deletedValue : keptDeletedValue;

      for (const row of sorted.slice(1)) {
        reassignedRows.push({
          kmsLimitId: row.kms_limit_id,
          fromDeleted: deletedValue,
          toDeleted: nextDeletedValue,
        });
        nextDeletedValue += 1;
      }
    }

    if (!reassignedRows.length) continue;

    const first = rows[0];
    const vehicleMeta = vehicleMetaMap.get(first.vendor_vehicle_type_id);
    plans.push({
      key,
      vendorId: first.vendor_id,
      vendorVehicleTypeId: first.vendor_vehicle_type_id,
      baseVehicleTypeId: vehicleMeta?.baseVehicleTypeId ?? first.vendor_vehicle_type_id,
      baseVehicleTypeTitle: vehicleMeta?.baseVehicleTypeTitle ?? String(first.vendor_vehicle_type_id),
      normalizedKm: normalizeKmValue(first),
      keptRowId,
      keptDeletedValue,
      rowIdsInGroup: rows.map((row) => row.kms_limit_id).sort((a, b) => a - b),
      reassignedRows,
    });
  }

  return plans.sort((a, b) => a.vendorId - b.vendorId || a.vendorVehicleTypeId - b.vendorVehicleTypeId || a.normalizedKm - b.normalizedKm);
}

function buildDeletedPricebookNormalizationPlans(
  allPricebooks: PricebookRow[],
  vehicleMetaMap: Map<number, VehicleTypeMeta>,
  branchMetaMap: Map<number, BranchMeta>,
  kmsLimitMap: Map<number, KmsLimitRow>,
): DeletedPricebookNormalizationPlan[] {
  const naturalGroups = new Map<string, PricebookRow[]>();

  for (const row of allPricebooks) {
    const key = [
      row.vendor_id,
      row.vendor_branch_id,
      row.vehicle_type_id,
      row.kms_limit_id,
      row.year ?? '',
      row.month ?? '',
    ].join('|');
    const list = naturalGroups.get(key) ?? [];
    list.push(row);
    naturalGroups.set(key, list);
  }

  const plans: DeletedPricebookNormalizationPlan[] = [];

  for (const [key, rows] of naturalGroups.entries()) {
    const duplicateDeletedRows = rows.filter((row) => Number(row.deleted || 0) > 0);
    if (duplicateDeletedRows.length < 2) continue;

    const byDeletedValue = new Map<number, PricebookRow[]>();
    for (const row of duplicateDeletedRows) {
      const deletedValue = Number(row.deleted || 0);
      const list = byDeletedValue.get(deletedValue) ?? [];
      list.push(row);
      byDeletedValue.set(deletedValue, list);
    }

    if (![...byDeletedValue.values()].some((items) => items.length > 1)) continue;

    let nextDeletedValue = Math.max(...rows.map((row) => Number(row.deleted || 0)), 1) + 1;
    const reassignedRows: Array<{ pricebookId: number; fromDeleted: number; toDeleted: number }> = [];
    let keptRowId = 0;
    let keptDeletedValue = 1;

    for (const [deletedValue, items] of [...byDeletedValue.entries()].sort((a, b) => a[0] - b[0])) {
      const sorted = [...items].sort((a, b) => a.vehicle_outstation_price_book_id - b.vehicle_outstation_price_book_id);
      keptRowId = keptRowId || sorted[0].vehicle_outstation_price_book_id;
      keptDeletedValue = keptRowId === sorted[0].vehicle_outstation_price_book_id ? deletedValue : keptDeletedValue;

      for (const row of sorted.slice(1)) {
        reassignedRows.push({
          pricebookId: row.vehicle_outstation_price_book_id,
          fromDeleted: deletedValue,
          toDeleted: nextDeletedValue,
        });
        nextDeletedValue += 1;
      }
    }

    if (!reassignedRows.length) continue;

    const first = rows[0];
    const vehicleMeta = vehicleMetaMap.get(first.vehicle_type_id);
    const branchMeta = branchMetaMap.get(first.vendor_branch_id);
    const kmsLimit = kmsLimitMap.get(first.kms_limit_id);
    plans.push({
      key,
      vendorId: first.vendor_id,
      vendorBranchId: first.vendor_branch_id,
      vendorBranchName: branchMeta?.vendor_branch_name ?? null,
      vehicleTypeId: first.vehicle_type_id,
      baseVehicleTypeId: vehicleMeta?.baseVehicleTypeId ?? first.vehicle_type_id,
      baseVehicleTypeTitle: vehicleMeta?.baseVehicleTypeTitle ?? String(first.vehicle_type_id),
      kmsLimitId: first.kms_limit_id,
      kmsLimitTitle: String(kmsLimit?.kms_limit_title || '').trim() || String(first.kms_limit_id),
      year: String(first.year ?? ''),
      month: String(first.month ?? ''),
      keptRowId,
      keptDeletedValue,
      rowIdsInGroup: rows.map((row) => row.vehicle_outstation_price_book_id).sort((a, b) => a - b),
      reassignedRows,
    });
  }

  return plans.sort((a, b) =>
    a.vendorId - b.vendorId ||
    a.vendorBranchId - b.vendorBranchId ||
    a.vehicleTypeId - b.vehicleTypeId ||
    a.kmsLimitId - b.kmsLimitId,
  );
}

function buildDuplicateReferenceCounts(
  duplicateKmsGroups: DuplicateKmsGroup[],
  allVendorPricebooks: PricebookRow[],
): Array<{ groupKey: string; canonicalKmsLimitId: number; duplicateKmsLimitId: number; activePricebookReferences: number }> {
  const counts = new Map<number, number>();
  for (const row of allVendorPricebooks) {
    if (Number(row.deleted || 0) !== 0) continue;
    counts.set(row.kms_limit_id, (counts.get(row.kms_limit_id) ?? 0) + 1);
  }

  return duplicateKmsGroups.flatMap((group) =>
    group.duplicateKmsLimitIds.map((duplicateKmsLimitId) => ({
      groupKey: group.key,
      canonicalKmsLimitId: group.canonicalKmsLimitId,
      duplicateKmsLimitId,
      activePricebookReferences: counts.get(duplicateKmsLimitId) ?? 0,
    })),
  );
}

function groupStalePricebookReferences(
  pricebooks: PricebookRow[],
  allVendorVehicleTypeMap: Map<number, VendorVehicleTypeRow>,
  allKmsLimitMap: Map<number, KmsLimitRow>,
  branchMetaMap: Map<number, BranchMeta>,
): StalePricebookReferenceGroup[] {
  const groups = new Map<string, { rows: PricebookRow[]; staleReasons: Set<string> }>();

  for (const row of pricebooks) {
    const vendorVehicleType = allVendorVehicleTypeMap.get(row.vehicle_type_id);
    const kmsLimit = allKmsLimitMap.get(row.kms_limit_id);
    const staleReasons: string[] = [];

    if (!vendorVehicleType) {
      staleReasons.push('missing_vendor_vehicle_type');
    } else if (Number(vendorVehicleType.deleted || 0) !== 0 || Number(vendorVehicleType.status || 0) === 0) {
      staleReasons.push('deleted_vendor_vehicle_type');
    }

    if (!kmsLimit) {
      staleReasons.push('missing_kms_limit');
    } else if (Number(kmsLimit.deleted || 0) !== 0 || Number(kmsLimit.status || 0) === 0) {
      staleReasons.push('deleted_kms_limit');
    }

    if (vendorVehicleType && kmsLimit && Number(kmsLimit.vendor_vehicle_type_id || 0) !== Number(row.vehicle_type_id || 0)) {
      staleReasons.push('kms_limit_vehicle_type_mismatch');
    }

    if (!staleReasons.length) continue;

    const key = [
      row.vendor_id,
      row.vendor_branch_id,
      row.vehicle_type_id,
      row.kms_limit_id,
      row.year ?? '',
      row.month ?? '',
    ].join('|');
    const existing = groups.get(key) ?? { rows: [], staleReasons: new Set<string>() };
    existing.rows.push(row);
    for (const reason of staleReasons) {
      existing.staleReasons.add(reason);
    }
    groups.set(key, existing);
  }

  return Array.from(groups.entries()).map(([key, value]) => {
    const first = value.rows[0];
    const branchMeta = branchMetaMap.get(first.vendor_branch_id);
    return {
      key,
      vendorId: first.vendor_id,
      vendorBranchId: first.vendor_branch_id,
      vendorBranchName: branchMeta?.vendor_branch_name ?? null,
      vehicleTypeId: first.vehicle_type_id,
      kmsLimitId: first.kms_limit_id,
      year: String(first.year ?? ''),
      month: String(first.month ?? ''),
      rowIds: value.rows.map((row) => row.vehicle_outstation_price_book_id),
      staleReasons: [...value.staleReasons].sort(),
      rows: value.rows.sort(compareRecencyDesc),
    };
  });
}

async function collectAuditSnapshot(args: CliArgs): Promise<{
  snapshot: AuditSnapshot;
  duplicateKmsGroups: DuplicateKmsGroup[];
  duplicateVendorVehicleTypeGroups: DuplicateVendorVehicleTypeGroup[];
  exactDuplicatePricebookGroups: ExactPricebookGroup[];
  deletedKmsLimitNormalizationPlans: DeletedKmsLimitNormalizationPlan[];
  deletedPricebookNormalizationPlans: DeletedPricebookNormalizationPlan[];
  stalePricebookReferenceGroups: StalePricebookReferenceGroup[];
  scopedPricebooks: PricebookRow[];
  allVendorPricebooks: PricebookRow[];
  kmsLimitMap: Map<number, KmsLimitRow>;
  allKmsLimitMap: Map<number, KmsLimitRow>;
  vehicleMetaMap: Map<number, VehicleTypeMeta>;
  allVendorVehicleTypeMap: Map<number, VendorVehicleTypeRow>;
  branchMetaMap: Map<number, BranchMeta>;
}> {
  const vendorWhere = args.vendorId ? { vendor_id: args.vendorId } : {};
  const [vendorVehicleTypes, allVendorVehicleTypes, kmsLimits, allKmsLimits, scopedPricebooks, allVendorPricebooks] = await Promise.all([
    prisma.dvi_vendor_vehicle_types.findMany({
      where: { ...vendorWhere, deleted: 0 },
      select: VENDOR_VEHICLE_TYPE_SELECT,
      orderBy: { vendor_vehicle_type_ID: 'asc' },
    }),
    prisma.dvi_vendor_vehicle_types.findMany({
      where: vendorWhere,
      select: VENDOR_VEHICLE_TYPE_SELECT,
      orderBy: { vendor_vehicle_type_ID: 'asc' },
    }),
    prisma.dvi_kms_limit.findMany({
      where: { ...vendorWhere, deleted: 0 },
      select: KMS_LIMIT_SELECT,
      orderBy: { kms_limit_id: 'asc' },
    }),
    prisma.dvi_kms_limit.findMany({
      where: vendorWhere,
      select: KMS_LIMIT_SELECT,
      orderBy: { kms_limit_id: 'asc' },
    }),
    prisma.dvi_vehicle_outstation_price_book.findMany({
      where: getScopedPricebookWhere(args),
      select: PRICEBOOK_SELECT,
      orderBy: { vehicle_outstation_price_book_id: 'asc' },
    }),
    prisma.dvi_vehicle_outstation_price_book.findMany({
      where: vendorWhere,
      select: PRICEBOOK_SELECT,
      orderBy: { vehicle_outstation_price_book_id: 'asc' },
    }),
  ]);

  const { vehicleMetaMap, branchMetaMap } = await loadMeta(allVendorVehicleTypes, scopedPricebooks);
  const kmsLimitMap = new Map(kmsLimits.map((row) => [row.kms_limit_id, row]));
  const allKmsLimitMap = new Map(allKmsLimits.map((row) => [row.kms_limit_id, row]));
  const allVendorVehicleTypeMap = new Map(allVendorVehicleTypes.map((row) => [row.vendor_vehicle_type_ID, row]));

  const duplicateVendorVehicleTypeGroups = groupDuplicateVendorVehicleTypes(vendorVehicleTypes, vehicleMetaMap);
  const duplicateKmsGroups = groupDuplicateKmsLimits(kmsLimits, vehicleMetaMap);
  const exactDuplicatePricebookGroups = groupExactDuplicatePricebooks(
    scopedPricebooks,
    vehicleMetaMap,
    branchMetaMap,
    kmsLimitMap,
  );
  const deletedKmsLimitNormalizationPlans = buildDeletedKmsLimitNormalizationPlans(allKmsLimits, vehicleMetaMap);
  const deletedPricebookNormalizationPlans = buildDeletedPricebookNormalizationPlans(
    allVendorPricebooks,
    vehicleMetaMap,
    branchMetaMap,
    allKmsLimitMap,
  );
  const stalePricebookReferenceGroups = groupStalePricebookReferences(
    scopedPricebooks,
    allVendorVehicleTypeMap,
    allKmsLimitMap,
    branchMetaMap,
  );

  return {
    snapshot: {
      generatedAt: new Date().toISOString(),
      filters: {
        vendorId: args.vendorId,
        allVendors: args.allVendors,
        branchId: args.branchId,
        year: args.year,
        month: args.month,
      },
      counts: {
        vendorVehicleTypeRows: vendorVehicleTypes.length,
        kmsLimitRows: kmsLimits.length,
        pricebookRowsInScope: scopedPricebooks.length,
        duplicateVendorVehicleTypeGroups: duplicateVendorVehicleTypeGroups.length,
        duplicateKmsGroups: duplicateKmsGroups.length,
        exactDuplicatePricebookGroups: exactDuplicatePricebookGroups.length,
        deletedKmsLimitDuplicateGroups: deletedKmsLimitNormalizationPlans.length,
        deletedPricebookDuplicateGroups: deletedPricebookNormalizationPlans.length,
        stalePricebookReferenceGroups: stalePricebookReferenceGroups.length,
      },
      duplicateVendorVehicleTypeGroups,
      duplicateKmsGroups,
      exactDuplicatePricebookGroups,
      deletedKmsLimitNormalizationPlans,
      deletedPricebookNormalizationPlans,
      stalePricebookReferenceGroups,
      verification: {
        duplicateKmsReferenceCounts: buildDuplicateReferenceCounts(duplicateKmsGroups, allVendorPricebooks),
      },
    },
    duplicateKmsGroups,
    duplicateVendorVehicleTypeGroups,
    exactDuplicatePricebookGroups,
    deletedKmsLimitNormalizationPlans,
    deletedPricebookNormalizationPlans,
    stalePricebookReferenceGroups,
    scopedPricebooks,
    allVendorPricebooks,
    kmsLimitMap,
    allKmsLimitMap,
    vehicleMetaMap,
    allVendorVehicleTypeMap,
    branchMetaMap,
  };
}

function buildMergedRowPlan(
  rows: PricebookRow[],
  canonicalKmsLimitId: number | null,
): {
  keeper: PricebookRow;
  mergedDays: Record<string, number | null>;
  mergedDaySources: MergedDaySource[];
  dayChanges: Array<{ day: string; before: number | null; after: number | null; sourceRowId: number | null }>;
  duplicateRowIdsToSoftDelete: number[];
  keeperNeedsUpdate: boolean;
} {
  const sortedRows = [...rows].sort(compareRecencyDesc);
  const canonicalRows = canonicalKmsLimitId === null
    ? []
    : sortedRows.filter((row) => row.kms_limit_id === canonicalKmsLimitId);
  const keeper = canonicalRows[0] ?? sortedRows[0];

  const mergedDays: Record<string, number | null> = {};
  const mergedDaySources: MergedDaySource[] = [];
  const dayChanges: Array<{ day: string; before: number | null; after: number | null; sourceRowId: number | null }> = [];

  for (const dayColumn of DAY_COLUMNS) {
    let chosenSource: PricebookRow | null = null;
    let chosenValue: number | null = null;

    for (const row of sortedRows) {
      if (!isValidPrice(row[dayColumn])) continue;
      chosenSource = row;
      chosenValue = normalizePrice(row[dayColumn]);
      break;
    }

    if (!chosenSource) {
      chosenSource = keeper;
      chosenValue = normalizePrice(keeper[dayColumn]);
    }

    mergedDays[dayColumn] = chosenValue;
    mergedDaySources.push({
      day: dayColumn,
      rowId: chosenSource ? chosenSource.vehicle_outstation_price_book_id : null,
      value: chosenValue,
    });

    const before = normalizePrice(keeper[dayColumn]);
    const after = chosenValue;
    if ((before ?? null) !== (after ?? null)) {
      dayChanges.push({
        day: dayColumn,
        before,
        after,
        sourceRowId: chosenSource ? chosenSource.vehicle_outstation_price_book_id : null,
      });
    }
  }

  const duplicateRowIdsToSoftDelete = sortedRows
    .filter((row) => row.vehicle_outstation_price_book_id !== keeper.vehicle_outstation_price_book_id)
    .map((row) => row.vehicle_outstation_price_book_id);

  const keeperNeedsUpdate =
    dayChanges.length > 0 ||
    (canonicalKmsLimitId !== null && keeper.kms_limit_id !== canonicalKmsLimitId);

  return {
    keeper,
    mergedDays,
    mergedDaySources,
    dayChanges,
    duplicateRowIdsToSoftDelete,
    keeperNeedsUpdate,
  };
}

function buildStaleReferenceRepairPlans(
  staleGroups: StalePricebookReferenceGroup[],
  scopedPricebooks: PricebookRow[],
  activeKmsLimitMap: Map<number, KmsLimitRow>,
  allKmsLimitMap: Map<number, KmsLimitRow>,
  vehicleMetaMap: Map<number, VehicleTypeMeta>,
  allVendorVehicleTypeMap: Map<number, VendorVehicleTypeRow>,
): { plans: StaleReferenceRepairPlan[]; unresolvedGroups: Array<{ key: string; reasons: string[] }> } {
  const activeVendorVehicleTypes = Array.from(allVendorVehicleTypeMap.values()).filter(
    (row) => Number(row.deleted || 0) === 0 && Number(row.status || 0) !== 0,
  );
  const activeVendorVehicleTypesByBase = new Map<number, VendorVehicleTypeRow[]>();
  for (const row of activeVendorVehicleTypes) {
    const list = activeVendorVehicleTypesByBase.get(row.vehicle_type_id) ?? [];
    list.push(row);
    activeVendorVehicleTypesByBase.set(row.vehicle_type_id, list.sort((a, b) => a.vendor_vehicle_type_ID - b.vendor_vehicle_type_ID));
  }

  const activeKmsLimits = Array.from(activeKmsLimitMap.values()).filter(
    (row) => Number(row.deleted || 0) === 0 && Number(row.status || 0) !== 0,
  );
  const activeKmsByVehicleAndKm = new Map<string, KmsLimitRow[]>();
  for (const row of activeKmsLimits) {
    const key = `${row.vendor_vehicle_type_id}|${normalizeKmValue(row)}`;
    const list = activeKmsByVehicleAndKm.get(key) ?? [];
    list.push(row);
    activeKmsByVehicleAndKm.set(key, list.sort((a, b) => a.kms_limit_id - b.kms_limit_id));
  }

  const plans: StaleReferenceRepairPlan[] = [];
  const unresolvedGroups: Array<{ key: string; reasons: string[] }> = [];

  for (const group of staleGroups) {
    const sampleRow = group.rows[0];
    const sourceVendorVehicleType = allVendorVehicleTypeMap.get(sampleRow.vehicle_type_id);
    const sourceKmsLimit = allKmsLimitMap.get(sampleRow.kms_limit_id);
    const baseVehicleTypeId = sourceVendorVehicleType?.vehicle_type_id ?? vehicleMetaMap.get(sampleRow.vehicle_type_id)?.baseVehicleTypeId;
    const baseVehicleTypeTitle = sourceVendorVehicleType
      ? vehicleMetaMap.get(sourceVendorVehicleType.vendor_vehicle_type_ID)?.baseVehicleTypeTitle
      : vehicleMetaMap.get(sampleRow.vehicle_type_id)?.baseVehicleTypeTitle;

    if (!baseVehicleTypeId) {
      unresolvedGroups.push({ key: group.key, reasons: [...group.staleReasons, 'unresolved_base_vehicle_type'] });
      continue;
    }

    const targetVendorVehicleType = (activeVendorVehicleTypesByBase.get(baseVehicleTypeId) ?? [])[0];
    if (!targetVendorVehicleType) {
      unresolvedGroups.push({ key: group.key, reasons: [...group.staleReasons, 'no_active_vendor_vehicle_type_for_base_type'] });
      continue;
    }

    if (!sourceKmsLimit) {
      unresolvedGroups.push({ key: group.key, reasons: [...group.staleReasons, 'no_source_kms_limit_record'] });
      continue;
    }

    const normalizedKm = normalizeKmValue(sourceKmsLimit);
    const targetKmsCandidates = activeKmsByVehicleAndKm.get(`${targetVendorVehicleType.vendor_vehicle_type_ID}|${normalizedKm}`) ?? [];
    const targetKms = targetKmsCandidates[0] ?? null;

    const targetScopedRows = scopedPricebooks.filter(
      (row) =>
        row.vehicle_outstation_price_book_id !== sampleRow.vehicle_outstation_price_book_id &&
        row.vendor_id === sampleRow.vendor_id &&
        row.vendor_branch_id === sampleRow.vendor_branch_id &&
        row.year === sampleRow.year &&
        row.month === sampleRow.month &&
        row.vehicle_type_id === targetVendorVehicleType.vendor_vehicle_type_ID &&
        (targetKms ? row.kms_limit_id === targetKms.kms_limit_id : false),
    );

    const anyActiveTargetRowsSameMonth = scopedPricebooks.filter(
      (row) =>
        row.vehicle_outstation_price_book_id !== sampleRow.vehicle_outstation_price_book_id &&
        row.vendor_id === sampleRow.vendor_id &&
        row.vendor_branch_id === sampleRow.vendor_branch_id &&
        row.year === sampleRow.year &&
        row.month === sampleRow.month &&
        row.vehicle_type_id === targetVendorVehicleType.vendor_vehicle_type_ID,
    );

    const sourceVendorVehicleTypeDeleted =
      !sourceVendorVehicleType || Number(sourceVendorVehicleType.deleted || 0) !== 0 || Number(sourceVendorVehicleType.status || 0) === 0;
    const shouldSoftDeleteOnly =
      !targetKms &&
      sourceVendorVehicleTypeDeleted &&
      anyActiveTargetRowsSameMonth.length > 0;

    const merged = buildMergedRowPlan([...group.rows, ...targetScopedRows], targetKms?.kms_limit_id ?? null);

    plans.push({
      key: group.key,
      vendorId: group.vendorId,
      vendorBranchId: group.vendorBranchId,
      vendorBranchName: group.vendorBranchName,
      year: group.year,
      month: group.month,
      sourceVehicleTypeId: group.vehicleTypeId,
      sourceKmsLimitId: group.kmsLimitId,
      targetVehicleTypeId: targetVendorVehicleType.vendor_vehicle_type_ID,
      targetBaseVehicleTypeId: baseVehicleTypeId,
      targetBaseVehicleTypeTitle: baseVehicleTypeTitle ?? String(baseVehicleTypeId),
      targetKmsLimitId: targetKms?.kms_limit_id ?? null,
      softDeleteOnly: shouldSoftDeleteOnly,
      softDeleteReason: shouldSoftDeleteOnly
        ? 'stale_deleted_vendor_vehicle_type_with_existing_active_target_package'
        : null,
      createKmsLimitIfMissing: !targetKms && !shouldSoftDeleteOnly,
      createKmsLimitPayload: !targetKms && !shouldSoftDeleteOnly
        ? {
            vendor_vehicle_type_id: targetVendorVehicleType.vendor_vehicle_type_ID,
            kms_limit_title: String(sourceKmsLimit.kms_limit_title || normalizedKm || ''),
            kms_limit: Number(sourceKmsLimit.kms_limit || normalizedKm || 0),
          }
        : null,
      normalizedKm,
      staleReasons: group.staleReasons,
      rowIdsInGroup: [...new Set([...group.rowIds, ...targetScopedRows.map((row) => row.vehicle_outstation_price_book_id)])],
      keeperRowId: merged.keeper.vehicle_outstation_price_book_id,
      duplicateRowIdsToSoftDelete: shouldSoftDeleteOnly
        ? [...new Set(group.rowIds)]
        : merged.duplicateRowIdsToSoftDelete,
      keeperNeedsUpdate:
        shouldSoftDeleteOnly
          ? false
          : merged.keeperNeedsUpdate ||
            merged.keeper.vehicle_type_id !== targetVendorVehicleType.vendor_vehicle_type_ID ||
            (targetKms ? merged.keeper.kms_limit_id !== targetKms.kms_limit_id : false),
      mergedDays: merged.mergedDays,
      mergedDaySources: merged.mergedDaySources,
      dayChanges: merged.dayChanges,
    });
  }

  return { plans, unresolvedGroups };
}

function buildCleanupPlan(
  args: CliArgs,
  duplicateKmsGroups: DuplicateKmsGroup[],
  exactDuplicatePricebookGroups: ExactPricebookGroup[],
  deletedKmsLimitNormalizationPlans: DeletedKmsLimitNormalizationPlan[],
  deletedPricebookNormalizationPlans: DeletedPricebookNormalizationPlan[],
  stalePricebookReferenceGroups: StalePricebookReferenceGroup[],
  scopedPricebooks: PricebookRow[],
  allVendorPricebooks: PricebookRow[],
  kmsLimitMap: Map<number, KmsLimitRow>,
  allKmsLimitMap: Map<number, KmsLimitRow>,
  vehicleMetaMap: Map<number, VehicleTypeMeta>,
  allVendorVehicleTypeMap: Map<number, VendorVehicleTypeRow>,
  branchMetaMap: Map<number, BranchMeta>,
  duplicateVendorVehicleTypeGroups: DuplicateVendorVehicleTypeGroup[],
): CleanupPlan & { unresolvedStaleReferenceGroups: Array<{ key: string; reasons: string[] }> } {
  const allVendorReferenceCounts = new Map<number, number>();
  for (const row of allVendorPricebooks) {
    if (Number(row.deleted || 0) !== 0) continue;
    allVendorReferenceCounts.set(row.kms_limit_id, (allVendorReferenceCounts.get(row.kms_limit_id) ?? 0) + 1);
  }

  const scopedRowsByKmsGroup = new Map<string, PricebookRow[]>();
  for (const row of scopedPricebooks) {
    const list = scopedRowsByKmsGroup.get(String(row.vehicle_type_id)) ?? [];
    list.push(row);
    scopedRowsByKmsGroup.set(String(row.vehicle_type_id), list);
  }

  const kmsMergePlans: KmsMergePlan[] = [];
  const touchedMonthlyKeys = new Set<string>();

  for (const group of duplicateKmsGroups) {
    const relevantRows = (scopedRowsByKmsGroup.get(String(group.vendorVehicleTypeId)) ?? [])
      .filter((row) => [group.canonicalKmsLimitId, ...group.duplicateKmsLimitIds].includes(row.kms_limit_id));

    const monthlyBuckets = new Map<string, PricebookRow[]>();
    for (const row of relevantRows) {
      const key = [
        row.vendor_id,
        row.vendor_branch_id,
        row.vehicle_type_id,
        row.year ?? '',
        row.month ?? '',
      ].join('|');
      const list = monthlyBuckets.get(key) ?? [];
      list.push(row);
      monthlyBuckets.set(key, list);
    }

    const monthlyPlans: MonthlyMergePlan[] = Array.from(monthlyBuckets.entries()).map(([key, rows]) => {
      const first = rows[0];
      const vehicleMeta = vehicleMetaMap.get(first.vehicle_type_id);
      const branchMeta = branchMetaMap.get(first.vendor_branch_id);
      const merged = buildMergedRowPlan(rows, group.canonicalKmsLimitId);

      touchedMonthlyKeys.add(key);

      return {
        key,
        vendorId: first.vendor_id,
        vendorBranchId: first.vendor_branch_id,
        vendorBranchName: branchMeta?.vendor_branch_name ?? null,
        vehicleTypeId: first.vehicle_type_id,
        baseVehicleTypeId: vehicleMeta?.baseVehicleTypeId ?? first.vehicle_type_id,
        baseVehicleTypeTitle: vehicleMeta?.baseVehicleTypeTitle ?? String(first.vehicle_type_id),
        canonicalKmsLimitId: group.canonicalKmsLimitId,
        sourceKmsLimitIds: [...new Set(rows.map((row) => row.kms_limit_id))].sort((a, b) => a - b),
        year: String(first.year ?? ''),
        month: String(first.month ?? ''),
        keeperRowId: merged.keeper.vehicle_outstation_price_book_id,
        keeperInitialKmsLimitId: merged.keeper.kms_limit_id,
        rowIdsInGroup: rows.map((row) => row.vehicle_outstation_price_book_id),
        duplicateRowIdsToSoftDelete: merged.duplicateRowIdsToSoftDelete,
        keeperNeedsUpdate: merged.keeperNeedsUpdate,
        dayChanges: merged.dayChanges,
        mergedDays: merged.mergedDays,
        mergedDaySources: merged.mergedDaySources,
      };
    });

    const currentDuplicateReferenceCounts = Object.fromEntries(
      group.duplicateKmsLimitIds.map((kmsLimitId) => [kmsLimitId, allVendorReferenceCounts.get(kmsLimitId) ?? 0]),
    ) as Record<number, number>;

    const scopedDuplicateReferenceCounts = new Map<number, number>();
    for (const monthlyPlan of monthlyPlans) {
      for (const rowId of monthlyPlan.rowIdsInGroup) {
        const row = relevantRows.find((item) => item.vehicle_outstation_price_book_id === rowId);
        if (!row) continue;
        if (!group.duplicateKmsLimitIds.includes(row.kms_limit_id)) continue;
        scopedDuplicateReferenceCounts.set(
          row.kms_limit_id,
          (scopedDuplicateReferenceCounts.get(row.kms_limit_id) ?? 0) + 1,
        );
      }
    }

    const plannedRemainingDuplicateReferenceCounts = Object.fromEntries(
      group.duplicateKmsLimitIds.map((kmsLimitId) => {
        const current = currentDuplicateReferenceCounts[kmsLimitId] ?? 0;
        const scoped = scopedDuplicateReferenceCounts.get(kmsLimitId) ?? 0;
        return [kmsLimitId, Math.max(current - scoped, 0)];
      }),
    ) as Record<number, number>;

    const duplicateKmsLimitIdsSafeToSoftDelete = group.duplicateKmsLimitIds.filter(
      (kmsLimitId) => (plannedRemainingDuplicateReferenceCounts[kmsLimitId] ?? 0) === 0 && monthlyPlans.length > 0,
    );

    const duplicateKmsLimitIdsBlockedByRemainingReferences = group.duplicateKmsLimitIds
      .map((kmsLimitId) => ({
        kmsLimitId,
        remainingActiveReferences: plannedRemainingDuplicateReferenceCounts[kmsLimitId] ?? 0,
      }))
      .filter((entry) => entry.remainingActiveReferences > 0);

    const orphanDuplicateKmsLimitIdsSafeToSoftDelete = group.duplicateKmsLimitIds.filter(
      (kmsLimitId) => (currentDuplicateReferenceCounts[kmsLimitId] ?? 0) === 0,
    );

    kmsMergePlans.push({
      groupKey: group.key,
      vendorId: group.vendorId,
      vendorVehicleTypeId: group.vendorVehicleTypeId,
      baseVehicleTypeId: group.baseVehicleTypeId,
      baseVehicleTypeTitle: group.baseVehicleTypeTitle,
      normalizedKm: group.normalizedKm,
      canonicalKmsLimitId: group.canonicalKmsLimitId,
      duplicateKmsLimitIds: group.duplicateKmsLimitIds,
      matchingMonthlyGroupCount: monthlyPlans.length,
      monthlyPlans,
      currentDuplicateReferenceCounts,
      plannedRemainingDuplicateReferenceCounts,
      duplicateKmsLimitIdsSafeToSoftDelete,
      duplicateKmsLimitIdsBlockedByRemainingReferences,
      orphanDuplicateKmsLimitIdsSafeToSoftDelete,
    });
  }

  const exactDuplicatePricebookPlans = exactDuplicatePricebookGroups
    .filter((group) => {
      const monthlyKey = [
        group.vendorId,
        group.vendorBranchId,
        group.vehicleTypeId,
        group.year,
        group.month,
      ].join('|');
      return !touchedMonthlyKeys.has(monthlyKey);
    })
    .map((group) => {
      const merged = buildMergedRowPlan(group.rows, null);
      return {
        key: group.key,
        vendorId: group.vendorId,
        vendorBranchId: group.vendorBranchId,
        vendorBranchName: group.vendorBranchName,
        vehicleTypeId: group.vehicleTypeId,
        baseVehicleTypeId: group.baseVehicleTypeId,
        baseVehicleTypeTitle: group.baseVehicleTypeTitle,
        kmsLimitId: group.kmsLimitId,
        kmsLimitTitle: group.kmsLimitTitle,
        year: group.year,
        month: group.month,
        keeperRowId: merged.keeper.vehicle_outstation_price_book_id,
        rowIdsInGroup: group.rowIds,
        duplicateRowIdsToSoftDelete: merged.duplicateRowIdsToSoftDelete,
        keeperNeedsUpdate: merged.keeperNeedsUpdate,
        dayChanges: merged.dayChanges,
        mergedDays: merged.mergedDays,
        mergedDaySources: merged.mergedDaySources,
      };
    });

  const staleReferenceRepair = args.allVendors
    ? { plans: [], unresolvedGroups: [] as Array<{ key: string; reasons: string[] }> }
    : buildStaleReferenceRepairPlans(
        stalePricebookReferenceGroups,
        scopedPricebooks,
        kmsLimitMap,
        allKmsLimitMap,
        vehicleMetaMap,
        allVendorVehicleTypeMap,
      );

  return {
    kmsMergePlans,
    exactDuplicatePricebookPlans,
    deletedKmsLimitNormalizationPlans,
    deletedPricebookNormalizationPlans,
    staleReferenceRepairPlans: staleReferenceRepair.plans,
    vendorVehicleTypeDuplicateGroups: duplicateVendorVehicleTypeGroups,
    unresolvedStaleReferenceGroups: staleReferenceRepair.unresolvedGroups,
  };
}

function collectAffectedIds(plan: CleanupPlan): {
  pricebookIds: number[];
  kmsLimitIds: number[];
} {
  const pricebookIds = new Set<number>();
  const kmsLimitIds = new Set<number>();

  for (const kmsPlan of plan.kmsMergePlans) {
    for (const monthlyPlan of kmsPlan.monthlyPlans) {
      pricebookIds.add(monthlyPlan.keeperRowId);
      for (const rowId of monthlyPlan.duplicateRowIdsToSoftDelete) {
        pricebookIds.add(rowId);
      }
    }

    for (const kmsLimitId of [
      ...kmsPlan.duplicateKmsLimitIdsSafeToSoftDelete,
      ...kmsPlan.orphanDuplicateKmsLimitIdsSafeToSoftDelete,
    ]) {
      kmsLimitIds.add(kmsLimitId);
    }
  }

  for (const exactPlan of plan.exactDuplicatePricebookPlans) {
    pricebookIds.add(exactPlan.keeperRowId);
    for (const rowId of exactPlan.duplicateRowIdsToSoftDelete) {
      pricebookIds.add(rowId);
    }
  }

  for (const deletedKmsPlan of plan.deletedKmsLimitNormalizationPlans) {
    kmsLimitIds.add(deletedKmsPlan.keptRowId);
    for (const row of deletedKmsPlan.reassignedRows) {
      kmsLimitIds.add(row.kmsLimitId);
    }
  }

  for (const deletedPricebookPlan of plan.deletedPricebookNormalizationPlans) {
    pricebookIds.add(deletedPricebookPlan.keptRowId);
    for (const row of deletedPricebookPlan.reassignedRows) {
      pricebookIds.add(row.pricebookId);
    }
  }

  for (const stalePlan of plan.staleReferenceRepairPlans) {
    pricebookIds.add(stalePlan.keeperRowId);
    for (const rowId of stalePlan.duplicateRowIdsToSoftDelete) {
      pricebookIds.add(rowId);
    }
    if (stalePlan.targetKmsLimitId) {
      kmsLimitIds.add(stalePlan.targetKmsLimitId);
    }
    if (stalePlan.sourceKmsLimitId) {
      kmsLimitIds.add(stalePlan.sourceKmsLimitId);
    }
  }

  return {
    pricebookIds: [...pricebookIds].sort((a, b) => a - b),
    kmsLimitIds: [...kmsLimitIds].sort((a, b) => a - b),
  };
}

async function buildBackupPayload(
  affectedIds: { pricebookIds: number[]; kmsLimitIds: number[] },
  duplicateVendorVehicleTypeGroups: DuplicateVendorVehicleTypeGroup[],
): Promise<{
  affectedPricebookRows: PricebookRow[];
  affectedKmsLimitRows: KmsLimitRow[];
  duplicateVendorVehicleTypeRows: VendorVehicleTypeRow[];
}> {
  const duplicateVendorVehicleTypeIds = duplicateVendorVehicleTypeGroups.flatMap((group) =>
    group.rows.map((row) => row.vendor_vehicle_type_ID),
  );

  const [affectedPricebookRows, affectedKmsLimitRows, duplicateVendorVehicleTypeRows] = await Promise.all([
    affectedIds.pricebookIds.length
      ? prisma.dvi_vehicle_outstation_price_book.findMany({
          where: { vehicle_outstation_price_book_id: { in: affectedIds.pricebookIds } },
          select: PRICEBOOK_SELECT,
          orderBy: { vehicle_outstation_price_book_id: 'asc' },
        })
      : Promise.resolve([]),
    affectedIds.kmsLimitIds.length
      ? prisma.dvi_kms_limit.findMany({
          where: { kms_limit_id: { in: affectedIds.kmsLimitIds } },
          select: KMS_LIMIT_SELECT,
          orderBy: { kms_limit_id: 'asc' },
        })
      : Promise.resolve([]),
    duplicateVendorVehicleTypeIds.length
      ? prisma.dvi_vendor_vehicle_types.findMany({
          where: { vendor_vehicle_type_ID: { in: duplicateVendorVehicleTypeIds } },
          select: VENDOR_VEHICLE_TYPE_SELECT,
          orderBy: { vendor_vehicle_type_ID: 'asc' },
        })
      : Promise.resolve([]),
  ]);

  return {
    affectedPricebookRows,
    affectedKmsLimitRows,
    duplicateVendorVehicleTypeRows,
  };
}

async function applyMonthlyMergePlan(
  tx: Prisma.TransactionClient,
  plan: MonthlyMergePlan,
  now: Date,
): Promise<{ updated: number; softDeleted: number }> {
  let updated = 0;

  if (plan.keeperNeedsUpdate) {
    await tx.dvi_vehicle_outstation_price_book.update({
      where: { vehicle_outstation_price_book_id: plan.keeperRowId },
      data: {
        kms_limit_id: plan.canonicalKmsLimitId,
        ...plan.mergedDays,
        status: 1,
        deleted: 0,
        updatedon: now,
      } as Prisma.dvi_vehicle_outstation_price_bookUpdateInput,
    });
    updated += 1;
  }

  let softDeleted = 0;
  if (plan.duplicateRowIdsToSoftDelete.length) {
    const result = await tx.dvi_vehicle_outstation_price_book.updateMany({
      where: {
        vehicle_outstation_price_book_id: { in: plan.duplicateRowIdsToSoftDelete },
        deleted: 0,
      },
      data: {
        deleted: 1,
        status: 0,
        updatedon: now,
      },
    });
    softDeleted += result.count;
  }

  return { updated, softDeleted };
}

async function applyExactDuplicatePlan(
  tx: Prisma.TransactionClient,
  plan: ExactDuplicateMergePlan,
  now: Date,
): Promise<{ updated: number; softDeleted: number }> {
  let updated = 0;

  if (plan.keeperNeedsUpdate) {
    await tx.dvi_vehicle_outstation_price_book.update({
      where: { vehicle_outstation_price_book_id: plan.keeperRowId },
      data: {
        ...plan.mergedDays,
        status: 1,
        deleted: 0,
        updatedon: now,
      } as Prisma.dvi_vehicle_outstation_price_bookUpdateInput,
    });
    updated += 1;
  }

  let softDeleted = 0;
  if (plan.duplicateRowIdsToSoftDelete.length) {
    const result = await tx.dvi_vehicle_outstation_price_book.updateMany({
      where: {
        vehicle_outstation_price_book_id: { in: plan.duplicateRowIdsToSoftDelete },
        deleted: 0,
      },
      data: {
        deleted: 1,
        status: 0,
        updatedon: now,
      },
    });
    softDeleted += result.count;
  }

  return { updated, softDeleted };
}

async function applyStaleReferenceRepairPlan(
  tx: Prisma.TransactionClient,
  plan: StaleReferenceRepairPlan,
  now: Date,
): Promise<{ updated: number; softDeleted: number; createdKms: number }> {
  let targetKmsLimitId = plan.targetKmsLimitId;
  let createdKms = 0;

  if (plan.softDeleteOnly) {
    let softDeleted = 0;
    if (plan.duplicateRowIdsToSoftDelete.length) {
      const result = await tx.dvi_vehicle_outstation_price_book.updateMany({
        where: {
          vehicle_outstation_price_book_id: { in: plan.duplicateRowIdsToSoftDelete },
          deleted: 0,
        },
        data: {
          deleted: 1,
          status: 0,
          updatedon: now,
        },
      });
      softDeleted += result.count;
    }

    return { updated: 0, softDeleted, createdKms: 0 };
  }

  if (!targetKmsLimitId && plan.createKmsLimitIfMissing && plan.createKmsLimitPayload) {
    const existing = await tx.dvi_kms_limit.findFirst({
      where: {
        vendor_id: plan.vendorId,
        vendor_vehicle_type_id: plan.createKmsLimitPayload.vendor_vehicle_type_id,
        deleted: 0,
        OR: [
          { kms_limit: plan.createKmsLimitPayload.kms_limit },
          { kms_limit_title: plan.createKmsLimitPayload.kms_limit_title },
        ],
      },
      orderBy: { kms_limit_id: 'asc' },
    });

    if (existing) {
      targetKmsLimitId = existing.kms_limit_id;
    } else {
      const created = await tx.dvi_kms_limit.create({
        data: {
          vendor_id: plan.vendorId,
          vendor_vehicle_type_id: plan.createKmsLimitPayload.vendor_vehicle_type_id,
          kms_limit_title: plan.createKmsLimitPayload.kms_limit_title,
          kms_limit: plan.createKmsLimitPayload.kms_limit,
          createdon: now,
          updatedon: now,
          status: 1,
          deleted: 0,
        },
      });
      targetKmsLimitId = created.kms_limit_id;
      createdKms += 1;
    }
  }

  if (!targetKmsLimitId) {
    return { updated: 0, softDeleted: 0, createdKms };
  }

  let updated = 0;
  await tx.dvi_vehicle_outstation_price_book.update({
    where: { vehicle_outstation_price_book_id: plan.keeperRowId },
    data: {
      vehicle_type_id: plan.targetVehicleTypeId,
      kms_limit_id: targetKmsLimitId,
      ...plan.mergedDays,
      status: 1,
      deleted: 0,
      updatedon: now,
    } as Prisma.dvi_vehicle_outstation_price_bookUpdateInput,
  });
  updated += 1;

  let softDeleted = 0;
  if (plan.duplicateRowIdsToSoftDelete.length) {
    const result = await tx.dvi_vehicle_outstation_price_book.updateMany({
      where: {
        vehicle_outstation_price_book_id: { in: plan.duplicateRowIdsToSoftDelete },
        deleted: 0,
      },
      data: {
        deleted: 1,
        status: 0,
        updatedon: now,
      },
    });
    softDeleted += result.count;
  }

  return { updated, softDeleted, createdKms };
}

async function applyDeletedKmsLimitNormalizationPlan(
  tx: Prisma.TransactionClient,
  plan: DeletedKmsLimitNormalizationPlan,
  now: Date,
): Promise<number> {
  let retagged = 0;

  for (const row of plan.reassignedRows) {
    await tx.dvi_kms_limit.update({
      where: { kms_limit_id: row.kmsLimitId },
      data: {
        deleted: row.toDeleted,
        status: 0,
        updatedon: now,
      },
    });
    retagged += 1;
  }

  return retagged;
}

async function applyDeletedPricebookNormalizationPlan(
  tx: Prisma.TransactionClient,
  plan: DeletedPricebookNormalizationPlan,
  now: Date,
): Promise<number> {
  let retagged = 0;

  for (const row of plan.reassignedRows) {
    await tx.dvi_vehicle_outstation_price_book.update({
      where: { vehicle_outstation_price_book_id: row.pricebookId },
      data: {
        deleted: row.toDeleted,
        status: 0,
        updatedon: now,
      },
    });
    retagged += 1;
  }

  return retagged;
}

async function applyCleanupPlan(plan: CleanupPlan): Promise<Summary['actionsApplied']> {
  const now = new Date();
  let pricebookRowsUpdated = 0;
  let pricebookRowsSoftDeleted = 0;
  let kmsLimitRowsSoftDeleted = 0;
  let kmsLimitRowsCreated = 0;
  let deletedKmsLimitRowsRetagged = 0;
  let deletedPricebookRowsRetagged = 0;

  for (const kmsPlan of plan.kmsMergePlans) {
    if (!kmsPlan.monthlyPlans.length && !kmsPlan.orphanDuplicateKmsLimitIdsSafeToSoftDelete.length) {
      continue;
    }

    await prisma.$transaction(async (tx) => {
      for (const monthlyPlan of kmsPlan.monthlyPlans) {
        const result = await applyMonthlyMergePlan(tx, monthlyPlan, now);
        pricebookRowsUpdated += result.updated;
        pricebookRowsSoftDeleted += result.softDeleted;
      }

      const duplicateKmsIdsToSoftDelete = [
        ...kmsPlan.duplicateKmsLimitIdsSafeToSoftDelete,
        ...kmsPlan.orphanDuplicateKmsLimitIdsSafeToSoftDelete,
      ].filter((value, index, array) => array.indexOf(value) === index);

      if (duplicateKmsIdsToSoftDelete.length) {
        const remainingReferences = await tx.dvi_vehicle_outstation_price_book.groupBy({
          by: ['kms_limit_id'],
          where: {
            kms_limit_id: { in: duplicateKmsIdsToSoftDelete },
            deleted: 0,
          },
          _count: { kms_limit_id: true },
        });

        const blockedIds = new Set(remainingReferences.map((row) => row.kms_limit_id));
        const safeIds = duplicateKmsIdsToSoftDelete.filter((kmsLimitId) => !blockedIds.has(kmsLimitId));

        if (safeIds.length) {
          const result = await tx.dvi_kms_limit.updateMany({
            where: {
              kms_limit_id: { in: safeIds },
              deleted: 0,
            },
            data: {
              deleted: 1,
              status: 0,
              updatedon: now,
            },
          });
          kmsLimitRowsSoftDeleted += result.count;
        }
      }
    });
  }

  for (const exactPlan of plan.exactDuplicatePricebookPlans) {
    await prisma.$transaction(async (tx) => {
      const result = await applyExactDuplicatePlan(tx, exactPlan, now);
      pricebookRowsUpdated += result.updated;
      pricebookRowsSoftDeleted += result.softDeleted;
    });
  }

  for (const stalePlan of plan.staleReferenceRepairPlans) {
    await prisma.$transaction(async (tx) => {
      const result = await applyStaleReferenceRepairPlan(tx, stalePlan, now);
      pricebookRowsUpdated += result.updated;
      pricebookRowsSoftDeleted += result.softDeleted;
      kmsLimitRowsCreated += result.createdKms;
    });
  }

  for (const deletedKmsPlan of plan.deletedKmsLimitNormalizationPlans) {
    await prisma.$transaction(async (tx) => {
      deletedKmsLimitRowsRetagged += await applyDeletedKmsLimitNormalizationPlan(tx, deletedKmsPlan, now);
    });
  }

  for (const deletedPricebookPlan of plan.deletedPricebookNormalizationPlans) {
    await prisma.$transaction(async (tx) => {
      deletedPricebookRowsRetagged += await applyDeletedPricebookNormalizationPlan(tx, deletedPricebookPlan, now);
    });
  }

  return {
    pricebookRowsUpdated,
    pricebookRowsSoftDeleted,
    kmsLimitRowsSoftDeleted,
    kmsLimitRowsCreated,
    deletedKmsLimitRowsRetagged,
    deletedPricebookRowsRetagged,
  };
}

function buildSummary(
  args: CliArgs,
  outputDirectory: string,
  files: Record<string, string>,
  beforeSnapshot: AuditSnapshot,
  afterSnapshot: AuditSnapshot,
  plan: CleanupPlan & { unresolvedStaleReferenceGroups?: Array<{ key: string; reasons: string[] }> },
  actionsApplied: Summary['actionsApplied'],
): Summary {
  const monthlyPricebookGroupsWithinKmsMerges = plan.kmsMergePlans.reduce(
    (sum, kmsPlan) => sum + kmsPlan.monthlyPlans.length,
    0,
  );
  const pricebookRowsToUpdate =
    plan.kmsMergePlans.reduce(
      (sum, kmsPlan) => sum + kmsPlan.monthlyPlans.filter((monthlyPlan) => monthlyPlan.keeperNeedsUpdate).length,
      0,
    ) +
    plan.exactDuplicatePricebookPlans.filter((item) => item.keeperNeedsUpdate).length +
    plan.staleReferenceRepairPlans.length;
  const pricebookRowsToSoftDelete =
    plan.kmsMergePlans.reduce(
      (sum, kmsPlan) =>
        sum + kmsPlan.monthlyPlans.reduce((subSum, monthlyPlan) => subSum + monthlyPlan.duplicateRowIdsToSoftDelete.length, 0),
      0,
    ) +
    plan.exactDuplicatePricebookPlans.reduce((sum, item) => sum + item.duplicateRowIdsToSoftDelete.length, 0) +
    plan.staleReferenceRepairPlans.reduce((sum, item) => sum + item.duplicateRowIdsToSoftDelete.length, 0);
  const kmsLimitRowsToSoftDelete = plan.kmsMergePlans.reduce(
    (sum, kmsPlan) =>
      sum +
      new Set([
        ...kmsPlan.duplicateKmsLimitIdsSafeToSoftDelete,
        ...kmsPlan.orphanDuplicateKmsLimitIdsSafeToSoftDelete,
      ]).size,
    0,
  );
  const kmsLimitRowsToCreate = plan.staleReferenceRepairPlans.filter((item) => item.createKmsLimitIfMissing).length;
  const deletedKmsLimitRowsToRetag = plan.deletedKmsLimitNormalizationPlans.reduce(
    (sum, item) => sum + item.reassignedRows.length,
    0,
  );
  const deletedPricebookRowsToRetag = plan.deletedPricebookNormalizationPlans.reduce(
    (sum, item) => sum + item.reassignedRows.length,
    0,
  );
  const kmsGroupsWithoutScopedPricebooks = plan.kmsMergePlans.filter(
    (kmsPlan) => kmsPlan.matchingMonthlyGroupCount === 0,
  ).length;
  const duplicateKmsLimitRowsBlockedByReferences = plan.kmsMergePlans.reduce(
    (sum, kmsPlan) => sum + kmsPlan.duplicateKmsLimitIdsBlockedByRemainingReferences.length,
    0,
  );
  const unresolvedStaleReferenceGroups = plan.unresolvedStaleReferenceGroups?.length ?? 0;

  const notes = [
    'Vendor vehicle type duplicates are audited only in this version.',
    'Duplicate KM limits are only soft-deleted when no active outstation pricebook rows still reference them.',
    'Already-deleted duplicate rows are re-tagged to unique non-zero deleted values so MySQL unique constraints can be added without hard-deleting history.',
    'Active pricebook rows pointing to deleted or mismatched vendor/KM masters are re-keyed when a safe active target exists, and stale orphan packages are soft-deleted instead of recreated when that would leave duplicate visible vehicle entries.',
    args.apply
      ? 'Apply mode executed with transaction-scoped merges and soft deletes.'
      : 'Dry-run mode wrote audits and merge plans without changing database rows.',
  ];

  if (args.branchId || args.year || args.month) {
    notes.push('Scope filters were applied for pricebook merges, so duplicate KM limits with references outside scope may remain active.');
  }

  if (args.allVendors) {
    notes.push('In --allVendors mode, stale reference re-key/create flows are intentionally skipped so the run stays focused on unique-constraint blockers.');
  }

  if (args.mergeVendorVehicleTypes) {
    notes.push('--mergeVendorVehicleTypes was requested, but the script intentionally keeps that flow audit-only for now.');
  }

  return {
    mode: args.apply ? 'apply' : 'dry-run',
    vendorId: args.vendorId,
    allVendors: args.allVendors,
    branchId: args.branchId,
    year: args.year,
    month: args.month,
    mergeVendorVehicleTypes: args.mergeVendorVehicleTypes,
    outputDirectory,
    files,
    countsBefore: beforeSnapshot.counts,
    countsAfter: afterSnapshot.counts,
    actionsPlanned: {
      kmsMergeGroups: plan.kmsMergePlans.length,
      monthlyPricebookGroupsWithinKmsMerges,
      exactDuplicatePricebookGroups: plan.exactDuplicatePricebookPlans.length,
      deletedKmsLimitDuplicateGroups: plan.deletedKmsLimitNormalizationPlans.length,
      deletedPricebookDuplicateGroups: plan.deletedPricebookNormalizationPlans.length,
      staleReferenceRepairGroups: plan.staleReferenceRepairPlans.length,
      pricebookRowsToUpdate,
      pricebookRowsToSoftDelete,
      kmsLimitRowsToSoftDelete,
      kmsLimitRowsToCreate,
      deletedKmsLimitRowsToRetag,
      deletedPricebookRowsToRetag,
      vendorVehicleTypeDuplicateGroups: plan.vendorVehicleTypeDuplicateGroups.length,
    },
    actionsApplied,
    skipped: {
      kmsGroupsWithoutScopedPricebooks,
      duplicateKmsLimitRowsBlockedByReferences,
      unresolvedStaleReferenceGroups,
      vendorVehicleTypeMergeSkipped: true,
    },
    notes,
  };
}

async function main() {
  const args = normalizeArgs(parseArgs(process.argv.slice(2)));
  const { outputDirectory, baseLabel } = await ensureOutputDirectory(args);

  const before = await collectAuditSnapshot(args);
  const plan = buildCleanupPlan(
    args,
    before.duplicateKmsGroups,
    before.exactDuplicatePricebookGroups,
    before.deletedKmsLimitNormalizationPlans,
    before.deletedPricebookNormalizationPlans,
    before.stalePricebookReferenceGroups,
    before.scopedPricebooks,
    before.allVendorPricebooks,
    before.kmsLimitMap,
    before.allKmsLimitMap,
    before.vehicleMetaMap,
    before.allVendorVehicleTypeMap,
    before.branchMetaMap,
    before.duplicateVendorVehicleTypeGroups,
  );

  const affectedIds = collectAffectedIds(plan);
  const backupPayload = await buildBackupPayload(affectedIds, before.duplicateVendorVehicleTypeGroups);

  const files = {
    auditBefore: path.join(outputDirectory, `${baseLabel}-audit-before.json`),
    plan: path.join(outputDirectory, `${baseLabel}-plan.json`),
    auditAfter: path.join(outputDirectory, `${baseLabel}-audit-after.json`),
    summary: path.join(outputDirectory, `${baseLabel}-summary.json`),
  };

  writeJson(files.auditBefore, {
    snapshot: before.snapshot,
    backups: backupPayload,
  });

  writeJson(files.plan, {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? 'apply' : 'dry-run',
    filters: {
      vendorId: args.vendorId,
      allVendors: args.allVendors,
      branchId: args.branchId,
      year: args.year,
      month: args.month,
    },
    plan,
  });

  const actionsApplied = args.apply
    ? await applyCleanupPlan(plan)
    : {
        pricebookRowsUpdated: 0,
        pricebookRowsSoftDeleted: 0,
        kmsLimitRowsSoftDeleted: 0,
        kmsLimitRowsCreated: 0,
        deletedKmsLimitRowsRetagged: 0,
        deletedPricebookRowsRetagged: 0,
      };

  const after = await collectAuditSnapshot(args);
  writeJson(files.auditAfter, after.snapshot);

  const summary = buildSummary(
    args,
    outputDirectory,
    files,
    before.snapshot,
    after.snapshot,
    plan,
    actionsApplied,
  );
  writeJson(files.summary, summary);

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        mode: summary.mode,
        vendorId: args.vendorId,
        allVendors: args.allVendors,
        branchId: args.branchId,
        year: args.year,
        month: args.month,
        outputDirectory,
        files,
        actionsPlanned: summary.actionsPlanned,
        actionsApplied: summary.actionsApplied,
        countsBefore: summary.countsBefore,
        countsAfter: summary.countsAfter,
        notes: summary.notes,
      },
      null,
      2,
    ),
  );

  if (!args.apply) {
    console.log('Dry-run only. Re-run with --apply and ALLOW_PROD_DB_CLEANUP=true to execute cleanup.');
  }
}

main()
  .catch((error) => {
    console.error('cleanup-vendor-outstation-duplicates failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
