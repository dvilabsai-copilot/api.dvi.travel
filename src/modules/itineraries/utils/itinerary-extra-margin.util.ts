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
  sourceCityId: number | null;
  destinationCityIds: number[];
  matchedRule: ExtraMarginRuleResolution | null;
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

  const routes =
    params.routes?.length
      ? params.routes
      : await prisma.dvi_itinerary_route_details.findMany({
          where: {
            itinerary_plan_ID: Number(
              params.plan?.itinerary_plan_ID || 0,
            ),
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
          toBigIntId(route?.location_id),
        )
        .filter(
          (id): id is bigint => id !== null,
        )
        .map((id) => id.toString()),
    ),
  ).map((id) => BigInt(id));

  if (!locationIds.length) {
    return {
      defaultPercentage,
      defaultDayLimit,
      noOfDays,
      noOfNights,
      sourceCityId: null,
      destinationCityIds: [],
      matchedRule: null,
    };
  }

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

  const locationMap = new Map(
    locations.map((location) => [
      String(location.location_ID),
      location,
    ]),
  );

  const orderedLocations = routes
    .map((route) =>
      locationMap.get(String(route?.location_id)),
    )
    .filter(Boolean);

  const sourceCityId =
    Number(orderedLocations[0]?.source_city_id || 0) ||
    null;

  const destinationCityIds = Array.from(
    new Set(
      orderedLocations
        .map((location) =>
          Number(location?.destination_city_id || 0),
        )
        .filter((id) => id > 0),
    ),
  );

  if (
    !sourceCityId ||
    !destinationCityIds.length ||
    noOfNights <= 0
  ) {
    return {
      defaultPercentage,
      defaultDayLimit,
      noOfDays,
      noOfNights,
      sourceCityId,
      destinationCityIds,
      matchedRule: null,
    };
  }

  const rule =
    await prisma.dvi_itinerary_extra_margin_rules.findFirst({
      where: {
        source_city_id: sourceCityId,
        destination_city_id: {
          in: destinationCityIds,
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
    sourceCityId,
    destinationCityIds,
    matchedRule: rule
      ? {
          rule_id: Number(rule.rule_id),
          source_city_id: Number(
            rule.source_city_id,
          ),
          destination_city_id: Number(
            rule.destination_city_id,
          ),
          min_nights: Number(rule.min_nights),
          max_nights: Number(rule.max_nights),
          adjustment_type:
            rule.adjustment_type === "fixed_amount"
              ? "fixed_amount"
              : "percentage",
          adjustment_value: Math.max(
            Number(rule.adjustment_value || 0),
            0,
          ),
          application_mode:
            rule.application_mode === "add"
              ? "add"
              : "override",
          priority: Number(rule.priority || 0),
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