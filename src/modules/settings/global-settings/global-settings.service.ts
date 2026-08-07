// FILE: src/modules/global-settings/global-settings.service.ts

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../prisma.service";
import { Prisma } from "@prisma/client";
import { UpdateGlobalSettingsDto } from "./dto/update-global-settings.dto";
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
