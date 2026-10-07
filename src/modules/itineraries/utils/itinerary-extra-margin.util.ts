import { PrismaService } from "../../../prisma.service";

export type ExtraMarginRuleResolution = {
  rule_id: number;
  source_city_id: number;
  destination_city_id: number;
  min_nights: number;
  max_nights: number;
  adjustment_type: "percentage" | "fixed_amount";
  adjustment_value: number;
  application_mode: "add" | "override";
  priority: number;
};

export type ResolvedExtraMarginConfig = {
  defaultPercentage: number;
  defaultDayLimit: number;
  noOfDays: number;
  noOfNights: number;

  // Kept for backward compatibility.
  // These no longer control rule matching.
  sourceCityId: number | null;
  destinationCityIds: number[];

  // Actual vendor IDs used for rule matching.
  vendorIds: number[];

  matchedRule:
    | ExtraMarginRuleResolution
    | null;
};

function finiteNumber(
  value: unknown,
): number | null {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBigIntId(
  value: unknown,
): bigint | null {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  try {
    const parsed = BigInt(String(value));
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

export async function resolveItineraryExtraMarginConfig(
  prisma: PrismaService,
  params: {
    plan: any;
    routes?: any[];
  },
): Promise<ResolvedExtraMarginConfig> {
  const globalSettings =
    await prisma.dvi_global_settings.findFirst({
      where: {
        deleted: 0,
      },
      orderBy: {
        global_settings_ID: "asc",
      },
      select: {
        itinerary_additional_margin_percentage: true,
        itinerary_additional_margin_day_limit: true,
      },
    });

  const configuredPercentage = finiteNumber(
    globalSettings?.itinerary_additional_margin_percentage,
  );

  const configuredDayLimit = finiteNumber(
    globalSettings?.itinerary_additional_margin_day_limit,
  );

  const envPercentage = finiteNumber(
    process.env.ITINERARY_ADDITIONAL_MARGIN_PERCENTAGE,
  );

  const envDayLimit = finiteNumber(
    process.env.ITINERARY_ADDITIONAL_MARGIN_DAY_LIMIT,
  );

  const defaultPercentage = Math.max(
    configuredPercentage ?? envPercentage ?? 10,
    0,
  );

  const defaultDayLimit = Math.max(
    Math.trunc(configuredDayLimit ?? envDayLimit ?? 3),
    0,
  );

  const noOfDays = Math.max(
    Math.trunc(Number(params.plan?.no_of_days || 0)),
    0,
  );

  const noOfNights = Math.max(
    Math.trunc(Number(params.plan?.no_of_nights || 0)),
    0,
  );

  const planId = Number(
  params.plan?.itinerary_plan_ID ||
    0,
);

/*
 * Keep the existing route/city resolution
 * only for backward compatibility.
 *
 * City values no longer decide which
 * Extra Margin rule matches.
 */
const routes =
  params.routes?.length
    ? params.routes
    : await prisma.dvi_itinerary_route_details.findMany({
        where: {
          itinerary_plan_ID: planId,
          deleted: 0,
          status: 1,
        },
        orderBy: {
          itinerary_route_ID: "asc",
        },
        select: {
          location_id: true,
        },
      });

const locationIds = Array.from(
  new Set(
    routes
      .map((route) =>
        toBigIntId(
          route?.location_id,
        ),
      )
      .filter(
        (id): id is bigint =>
          id !== null,
      )
      .map((id) => id.toString()),
  ),
).map((id) => BigInt(id));

let sourceCityId:
  | number
  | null = null;

let destinationCityIds:
  number[] = [];

if (locationIds.length) {
  const locations =
    await prisma.dvi_stored_locations.findMany({
      where: {
        location_ID: {
          in: locationIds,
        },
        deleted: 0,
      },
      select: {
        location_ID: true,
        source_city_id: true,
        destination_city_id: true,
      },
    });

  const locationMap =
    new Map(
      locations.map(
        (location) => [
          String(
            location.location_ID,
          ),
          location,
        ],
      ),
    );

  const orderedLocations =
    routes
      .map((route) =>
        locationMap.get(
          String(
            route?.location_id,
          ),
        ),
      )
      .filter(Boolean);

  sourceCityId =
    Number(
      orderedLocations[0]
        ?.source_city_id || 0,
    ) || null;

  destinationCityIds =
    Array.from(
      new Set(
        orderedLocations
          .map((location) =>
            Number(
              location
                ?.destination_city_id ||
                0,
            ),
          )
          .filter(
            (id) => id > 0,
          ),
      ),
    );
}

/*
 * Resolve the actual selected itinerary
 * vendors.
 *
 * Primary source:
 * dvi_itinerary_plan_vehicle_vendor_selection
 *
 * Fallback:
 * assigned vendor eligible rows, for
 * older itineraries / compatibility.
 */
let selectedVendorRows: Array<{
  vendor_id: number | null;
}> = [];

let assignedVendorRows: Array<{
  vendor_id: number | null;
}> = [];

if (planId > 0) {
  [
    selectedVendorRows,
    assignedVendorRows,
  ] = await Promise.all([
    prisma.dvi_itinerary_plan_vehicle_vendor_selection.findMany({
      where: {
        itinerary_plan_id:
          planId,
        status: 1,
        deleted: 0,
        vendor_id: {
          gt: 0,
        },
      },
      select: {
        vendor_id: true,
      },
    }),

    prisma.dvi_itinerary_plan_vendor_eligible_list.findMany({
      where: {
        itinerary_plan_id:
          planId,
        itineary_plan_assigned_status:
          1,
        status: 1,
        deleted: 0,
        vendor_id: {
          gt: 0,
        },
      },
      select: {
        vendor_id: true,
      },
    }),
  ]);
}

const vendorIds = Array.from(
  new Set(
    [
      ...selectedVendorRows,
      ...assignedVendorRows,
    ]
      .map((row) =>
        Number(
          row.vendor_id || 0,
        ),
      )
      .filter(
        (vendorId) =>
          vendorId > 0,
      ),
  ),
);

/*
 * No vendor selected = no vendor-specific
 * rule. Existing default Additional Margin
 * behavior remains untouched.
 */
if (
  !vendorIds.length ||
  noOfNights <= 0
) {
  return {
    defaultPercentage,
    defaultDayLimit,
    noOfDays,
    noOfNights,
    sourceCityId,
    destinationCityIds,
    vendorIds,
    matchedRule: null,
  };
}

/*
 * One rule can contain multiple vendors.
 * Matching ANY one selected vendor makes
 * that rule eligible.
 *
 * The rule itself is still applied only once.
 */
const ruleVendorRows =
  (await prisma.dvi_itinerary_extra_margin_rule_vendors.findMany({
    where: {
      vendor_id: {
        in: vendorIds,
      },
    },
    select: {
      rule_id: true,
      vendor_id: true,
    },
  })) as Array<{
    rule_id: number;
    vendor_id: number;
  }>;

const matchingRuleIds: number[] =
  Array.from(
    new Set<number>(
      ruleVendorRows.map(
        (row) =>
          Number(row.rule_id),
      ),
    ),
  );

if (!matchingRuleIds.length) {
  return {
    defaultPercentage,
    defaultDayLimit,
    noOfDays,
    noOfNights,
    sourceCityId,
    destinationCityIds,
    vendorIds,
    matchedRule: null,
  };
}

const rule =
  await prisma.dvi_itinerary_extra_margin_rules.findFirst({
    where: {
      rule_id: {
        in: matchingRuleIds,
      },

      min_nights: {
        lte: noOfNights,
      },

      max_nights: {
        gte: noOfNights,
      },

      status: 1,
      deleted: 0,
    },

    orderBy: [
      {
        priority: "desc",
      },
      {
        rule_id: "desc",
      },
    ],
  });

return {
  defaultPercentage,
  defaultDayLimit,
  noOfDays,
  noOfNights,

  // Retained only for compatibility.
  sourceCityId,
  destinationCityIds,

  // Actual rule matching context.
  vendorIds,

  matchedRule: rule
    ? {
        rule_id: Number(
          rule.rule_id,
        ),

        source_city_id: Number(
          rule.source_city_id ||
            0,
        ),

        destination_city_id:
          Number(
            rule.destination_city_id ||
              0,
          ),

        min_nights: Number(
          rule.min_nights,
        ),

        max_nights: Number(
          rule.max_nights,
        ),

        adjustment_type:
          rule.adjustment_type ===
          "fixed_amount"
            ? "fixed_amount"
            : "percentage",

        adjustment_value:
          Math.max(
            Number(
              rule.adjustment_value ||
                0,
            ),
            0,
          ),

        application_mode:
          rule.application_mode ===
          "add"
            ? "add"
            : "override",

        priority: Number(
          rule.priority || 0,
        ),
      }
    : null,
};
}

export function getPercentageMarginForDisplay(
  config: ResolvedExtraMarginConfig,
): number {
  const defaultPercentage =
    config.noOfDays <= config.defaultDayLimit
      ? config.defaultPercentage
      : 0;

  const rule = config.matchedRule;

  if (!rule) {
    return defaultPercentage;
  }

  if (rule.adjustment_type !== "percentage") {
    return rule.application_mode === "override"
      ? 0
      : defaultPercentage;
  }

  return rule.application_mode === "override"
    ? rule.adjustment_value
    : defaultPercentage + rule.adjustment_value;
}