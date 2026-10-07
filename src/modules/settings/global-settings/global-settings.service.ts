// FILE: src/modules/global-settings/global-settings.service.ts

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../prisma.service";
import { Prisma } from "@prisma/client";
import {
  CreateExtraMarginRuleDto,
  UpdateExtraMarginRuleDto,
  UpdateGlobalSettingsDto,
} from "./dto/update-global-settings.dto";
import { StateConfigResultDto, StateConfigUpdateDto } from "./dto/state-config.dto";

@Injectable()
export class GlobalSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private toTimeDate(value: string | Date | null | undefined): Date | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    if (value instanceof Date) return value;

    const time = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (time) {
      const hours = Number(time[1]);
      const minutes = Number(time[2]);
      const seconds = Number(time[3] ?? 0);
      if (hours > 23 || minutes > 59 || seconds > 59) {
        throw new BadRequestException(`Invalid time value: ${value}`);
      }
      // Prisma represents MySQL TIME columns as Date values. Use a stable
      // UTC epoch so the stored clock time is not shifted by server timezone.
      return new Date(Date.UTC(1970, 0, 1, hours, minutes, seconds));
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid time value: ${value}`);
    }
    return parsed;
  }

  private normalizeBoolean(value: unknown): boolean | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value === 1;
    if (typeof value === "string") {
      return ["1", "true", "yes"].includes(value.trim().toLowerCase());
    }
    return Boolean(value);
  }

 /**
   * Mirrors global_settings.php:
   * Fetch the single active row from dvi_global_settings (deleted = 0).
 */
  async getGlobalSettings() {
    const row = await this.prisma.dvi_global_settings.findFirst({
      where: { deleted: 0 },
      orderBy: { global_settings_ID: "asc" },
    });

    if (!row) {
      throw new NotFoundException("Global settings not initialized in database");
    }

    return row;
  }

  /**
   * Return the active global hotel margin. The database setting is
   * authoritative; HOTEL_MARGIN is retained only for installations that have
   * not initialized dvi_global_settings yet.
   */
  async getHotelMarginPercentage(): Promise<number> {
    const row = await this.prisma.dvi_global_settings.findFirst({
      where: { deleted: 0, status: 1 },
      orderBy: { global_settings_ID: "asc" },
      select: { hotel_margin: true },
    });

    const configured = row?.hotel_margin;
    if (configured !== null && configured !== undefined) {
      const value = Number(configured);
      return Number.isFinite(value) ? Math.max(value, 0) : 0;
    }

    const fallback = Number(process.env.HOTEL_MARGIN ?? 0);
    return Number.isFinite(fallback) ? Math.max(fallback, 0) : 0;
  }

 /**
   * Mirrors __ajax_manage_global_setting.php:
   * type = global_settings_update
   *
   * Update the single global settings row (all config values) and return it.
   *
   * The PHP page submits the settings row id (normally 1). We resolve the
   * active row first, then update that exact row so multiple stale rows cannot
   * all be changed accidentally.
 */
  async updateGlobalSettings(dto: UpdateGlobalSettingsDto, userId?: number) {
    const data: Prisma.dvi_global_settingsUpdateInput = {
      ...(dto as any),
      updatedon: new Date(),
      ...(typeof userId === "number" ? { createdby: userId } : {}),
    };

    for (const field of [
      "itinerary_common_buffer_time",
      "itinerary_travel_by_flight_buffer_time",
      "itinerary_travel_by_train_buffer_time",
      "itinerary_travel_by_road_buffer_time",
    ] as const) {
      if (field in dto) {
        (data as any)[field] = this.toTimeDate(dto[field]);
      }
    }

    if ("hotel_margin_gst_type" in dto) {
      (data as any).hotel_margin_gst_type = this.normalizeBoolean(dto.hotel_margin_gst_type);
    }

 // If there is no row yet, create one first.
    const existing = await this.prisma.dvi_global_settings.findFirst({
      where: { deleted: 0 },
    });

    if (!existing) {
      await this.prisma.dvi_global_settings.create({
        data: {
          ...(data as any),
          createdby: typeof userId === "number" ? userId : 0,
          createdon: new Date(),
          updatedon: new Date(),
          status: 1,
          deleted: 0,
        },
      });

      return this.getGlobalSettings();
    }

    await this.prisma.dvi_global_settings.update({
      where: { global_settings_ID: existing.global_settings_ID },
      data,
    });

    return this.getGlobalSettings();
  }

 /**
   * Mirrors __ajax_fetch_state_config.php:
   * Given a state id, return its on-ground and escalation numbers.
 */
  async getStateConfig(stateId: number): Promise<StateConfigResultDto> {
    const state = await this.prisma.dvi_states.findFirst({
      where: { id: stateId, deleted: 0 },
      select: {
        id: true,
        country_id: true,
        name: true,
        vehicle_onground_support_number: true,
        vehicle_escalation_call_number: true,
      },
    });

    if (!state) {
      throw new NotFoundException("State not found");
    }

    return {
      stateId: state.id,
      countryId: state.country_id,
      stateName: state.name,
      vehicleOngroundSupportNumber: state.vehicle_onground_support_number,
      vehicleEscalationCallNumber: state.vehicle_escalation_call_number,
    };
  }

 /**
   * Mirrors __ajax_manage_global_setting.php:
   * type = state_config_update
   *
   * Update the two vehicle support numbers for a state.
 */
  async updateStateConfig(dto: StateConfigUpdateDto): Promise<StateConfigResultDto> {
    const existing = await this.prisma.dvi_states.findFirst({
      where: { id: dto.stateId, deleted: 0 },
    });

    if (!existing) {
      throw new NotFoundException("State not found");
    }

    const updated = await this.prisma.dvi_states.update({
      where: { id: dto.stateId },
      data: {
        vehicle_onground_support_number: dto.vehicleOngroundSupportNumber ?? null,
        vehicle_escalation_call_number: dto.vehicleEscalationCallNumber ?? null,
        updatedon: new Date(),
      },
      select: {
        id: true,
        country_id: true,
        name: true,
        vehicle_onground_support_number: true,
        vehicle_escalation_call_number: true,
      },
    });

    return {
      stateId: updated.id,
      countryId: updated.country_id,
      stateName: updated.name,
      vehicleOngroundSupportNumber: updated.vehicle_onground_support_number,
      vehicleEscalationCallNumber: updated.vehicle_escalation_call_number,
    };
  }

 /**
   * Helper for the Global Settings screen:
   * List states (optionally by country) for the dropdown.
   * Mirrors the old PHP helper that filled the "State" select.
   *
   * IMPORTANT:
   * - If countryId is not provided, we default to India (country_id = 101),
   *   which matches the legacy PHP behavior for Global Settings.
 */
  async listStatesByCountry(countryId?: number) {
    const effectiveCountryId =
 typeof countryId === "number" && !Number.isNaN(countryId) ? countryId : 101; // 101 = India

    return this.prisma.dvi_states.findMany({
      where: {
        deleted: 0,
        country_id: effectiveCountryId,
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        country_id: true,
      },
    });
  }

private validateExtraMarginRulePayload(
  dto:
    | CreateExtraMarginRuleDto
    | UpdateExtraMarginRuleDto,
  existing?: any,
  existingVendorIds: number[] = [],
) {
  const rawVendorIds =
    Array.isArray(dto.vendor_ids)
      ? dto.vendor_ids.map((id) =>
          Number(id),
        )
      : existingVendorIds.map((id) =>
          Number(id),
        );

  if (
    !rawVendorIds.length ||
    rawVendorIds.some(
      (id) =>
        !Number.isInteger(id) ||
        id <= 0,
    )
  ) {
    throw new BadRequestException(
      "At least one valid vendor is required",
    );
  }

  const vendorIds = Array.from(
    new Set(rawVendorIds),
  );

  const minNights = Number(
    dto.min_nights ??
      existing?.min_nights ??
      1,
  );

  const maxNights = Number(
    dto.max_nights ??
      existing?.max_nights ??
      999,
  );

  const adjustmentType = String(
    dto.adjustment_type ??
      existing?.adjustment_type ??
      "",
  )
    .trim()
    .toLowerCase();

  const adjustmentValue = Number(
    dto.adjustment_value ??
      existing?.adjustment_value ??
      0,
  );

  const applicationMode = String(
    dto.application_mode ??
      existing?.application_mode ??
      "",
  )
    .trim()
    .toLowerCase();

  const priority = Number(
    dto.priority ??
      existing?.priority ??
      0,
  );

  const status =
    Number(
      dto.status ??
        existing?.status ??
        1,
    ) === 0
      ? 0
      : 1;

  if (
    !Number.isInteger(minNights) ||
    !Number.isInteger(maxNights) ||
    minNights < 1 ||
    maxNights < minNights
  ) {
    throw new BadRequestException(
      "Maximum nights must be greater than or equal to minimum nights",
    );
  }

  if (
    ![
      "percentage",
      "fixed_amount",
    ].includes(adjustmentType)
  ) {
    throw new BadRequestException(
      "Adjustment type must be percentage or fixed_amount",
    );
  }

  if (
    !Number.isFinite(
      adjustmentValue,
    ) ||
    adjustmentValue < 0
  ) {
    throw new BadRequestException(
      "Adjustment value must be zero or greater",
    );
  }

  if (
    adjustmentType ===
      "percentage" &&
    adjustmentValue > 100
  ) {
    throw new BadRequestException(
      "Percentage adjustment cannot be greater than 100",
    );
  }

  if (
    !["add", "override"].includes(
      applicationMode,
    )
  ) {
    throw new BadRequestException(
      "Application mode must be add or override",
    );
  }

  if (
    !Number.isInteger(priority) ||
    priority < 0
  ) {
    throw new BadRequestException(
      "Priority must be zero or greater",
    );
  }

  return {
    vendor_ids: vendorIds,
    min_nights: minNights,
    max_nights: maxNights,
    adjustment_type:
      adjustmentType as
        | "percentage"
        | "fixed_amount",
    adjustment_value:
      adjustmentValue,
    application_mode:
      applicationMode as
        | "add"
        | "override",
    priority,
    status,
  };
}

private async assertExtraMarginVendorsExist(
  vendorIds: number[],
) {
  const vendorRows =
    await this.prisma.dvi_vendor_details.findMany({
      where: {
        vendor_id: {
          in: vendorIds,
        },
        deleted: 0,
      },
      select: {
        vendor_id: true,
      },
    });

  const availableVendorIds =
    new Set(
      vendorRows.map((vendor) =>
        Number(vendor.vendor_id),
      ),
    );

  const missingVendorIds =
    vendorIds.filter(
      (vendorId) =>
        !availableVendorIds.has(
          vendorId,
        ),
    );

  if (missingVendorIds.length) {
    throw new BadRequestException(
      `Selected vendor is not available: ${missingVendorIds.join(
        ", ",
      )}`,
    );
  }
}

private async hydrateExtraMarginRules(
  rules: any[],
) {
  if (!rules.length) {
    return [];
  }

  const ruleIds = rules.map((rule) =>
    Number(rule.rule_id),
  );

 const ruleVendorRows =
  (await this.prisma.dvi_itinerary_extra_margin_rule_vendors.findMany({
    where: {
      rule_id: {
        in: ruleIds,
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

  const vendorIds: number[] = Array.from(
  new Set<number>(
    (
      ruleVendorRows as Array<{
        rule_id: number;
        vendor_id: number;
      }>
    ).map((row) =>
      Number(row.vendor_id),
    ),
  ),
);

  const vendorRows = vendorIds.length
    ? await this.prisma.dvi_vendor_details.findMany({
        where: {
          vendor_id: {
            in: vendorIds,
          },
          deleted: 0,
        },
        select: {
          vendor_id: true,
          vendor_name: true,
        },
      })
    : [];

  const vendorNameMap = new Map(
    vendorRows.map((vendor) => [
      Number(vendor.vendor_id),
      String(
        vendor.vendor_name || "",
      ).trim(),
    ]),
  );

  const vendorsByRule = new Map<
    number,
    number[]
  >();

  for (const row of ruleVendorRows) {
    const ruleId = Number(
      row.rule_id,
    );

    const vendorId = Number(
      row.vendor_id,
    );

    const current =
      vendorsByRule.get(ruleId) ||
      [];

    current.push(vendorId);

    vendorsByRule.set(
      ruleId,
      current,
    );
  }

  return rules.map((rule) => {
    const ruleId = Number(
      rule.rule_id,
    );

    const ruleVendorIds =
      vendorsByRule.get(ruleId) ||
      [];

    return {
      ...rule,

      vendor_ids:
        ruleVendorIds,

      vendors:
        ruleVendorIds.map(
          (vendorId) => ({
            vendor_id: vendorId,

            vendor_name:
              vendorNameMap.get(
                vendorId,
              ) ||
              `Vendor #${vendorId}`,
          }),
        ),
    };
  });
}
  async listExtraMarginRules() {
  const rules =
    await this.prisma.dvi_itinerary_extra_margin_rules.findMany({
      where: {
        deleted: 0,
      },
      orderBy: [
        { priority: "desc" },
        { rule_id: "desc" },
      ],
    });

  return this.hydrateExtraMarginRules(
    rules,
  );
}

  async createExtraMarginRule(
  dto: CreateExtraMarginRuleDto,
  userId?: number,
) {
  const {
    vendor_ids,
    ...data
  } =
    this.validateExtraMarginRulePayload(
      dto,
    );

  await this.assertExtraMarginVendorsExist(
    vendor_ids,
  );

  const rule =
    await this.prisma.$transaction(
      async (tx) => {
        const createdRule =
          await tx.dvi_itinerary_extra_margin_rules.create({
            data: {
              // Legacy columns are intentionally
              // retained for backward compatibility,
              // but are no longer used for matching.
              source_city_id: 0,
              destination_city_id: 0,

              ...data,

              createdby:
                typeof userId === "number"
                  ? userId
                  : 0,

              createdon: new Date(),
              updatedon: new Date(),
              deleted: 0,
            },
          });

        await tx.dvi_itinerary_extra_margin_rule_vendors.createMany({
          data: vendor_ids.map(
            (vendorId) => ({
              rule_id:
                createdRule.rule_id,
              vendor_id: vendorId,
              createdon: new Date(),
              updatedon: new Date(),
            }),
          ),
        });

        return createdRule;
      },
    );

  const [hydratedRule] =
    await this.hydrateExtraMarginRules([
      rule,
    ]);

  return hydratedRule;
}

  async updateExtraMarginRule(
  ruleId: number,
  dto: UpdateExtraMarginRuleDto,
) {
  const existing =
    await this.prisma.dvi_itinerary_extra_margin_rules.findFirst({
      where: {
        rule_id: ruleId,
        deleted: 0,
      },
    });

  if (!existing) {
    throw new NotFoundException(
      "Extra margin rule not found",
    );
  }

  const existingVendorRows =
    await this.prisma.dvi_itinerary_extra_margin_rule_vendors.findMany({
      where: {
        rule_id: ruleId,
      },
      select: {
        vendor_id: true,
      },
    });

  const existingVendorIds =
    existingVendorRows.map((row) =>
      Number(row.vendor_id),
    );

  const {
    vendor_ids,
    ...data
  } =
    this.validateExtraMarginRulePayload(
      dto,
      existing,
      existingVendorIds,
    );

  await this.assertExtraMarginVendorsExist(
    vendor_ids,
  );

  const rule =
    await this.prisma.$transaction(
      async (tx) => {
        const updatedRule =
          await tx.dvi_itinerary_extra_margin_rules.update({
            where: {
              rule_id: ruleId,
            },
            data: {
              ...data,
              updatedon: new Date(),
            },
          });

        await tx.dvi_itinerary_extra_margin_rule_vendors.deleteMany({
          where: {
            rule_id: ruleId,
          },
        });

        await tx.dvi_itinerary_extra_margin_rule_vendors.createMany({
          data: vendor_ids.map(
            (vendorId) => ({
              rule_id: ruleId,
              vendor_id: vendorId,
              createdon: new Date(),
              updatedon: new Date(),
            }),
          ),
        });

        return updatedRule;
      },
    );

  const [hydratedRule] =
    await this.hydrateExtraMarginRules([
      rule,
    ]);

  return hydratedRule;
}

  async deleteExtraMarginRule(
  ruleId: number,
) {
  const existing =
    await this.prisma.dvi_itinerary_extra_margin_rules.findFirst({
      where: {
        rule_id: ruleId,
        deleted: 0,
      },
    });

  if (!existing) {
    throw new NotFoundException(
      "Extra margin rule not found",
    );
  }

  await this.prisma.$transaction(
    async (tx) => {
      await tx.dvi_itinerary_extra_margin_rules.update({
        where: {
          rule_id: ruleId,
        },
        data: {
          status: 0,
          deleted: 1,
          updatedon: new Date(),
        },
      });

      await tx.dvi_itinerary_extra_margin_rule_vendors.deleteMany({
        where: {
          rule_id: ruleId,
        },
      });
    },
  );

  return {
    ok: true,
  };
}
  async listCountries() {
    return this.prisma.dvi_countries.findMany({
      where: {
        deleted: 0,
      },
      orderBy: {
        name: "asc",
      },
      select: {
        id: true,
        name: true,
 shortname: true, // e.g. "IN", "AE", "US"
        phonecode: true,
      },
    });
  }
}
