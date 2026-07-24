// FILE: src/modules/global-settings/global-settings.service.ts

import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../prisma.service";
import { Prisma } from "@prisma/client";
import { UpdateGlobalSettingsDto } from "./dto/update-global-settings.dto";
import { StateConfigResultDto, StateConfigUpdateDto } from "./dto/state-config.dto";

@Injectable()
export class GlobalSettingsService {
  constructor(private readonly prisma: PrismaService) {}

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
   * Mirrors __ajax_manage_global_setting.php:
   * type = global_settings_update
   *
   * Update the single global settings row (all config values) and return it.
   *
   * NOTE: we intentionally use updateMany(with deleted=0) instead of id=1
   * to be robust if the id is not exactly 1.
 */
  async updateGlobalSettings(dto: UpdateGlobalSettingsDto, userId?: number) {
    const data: Prisma.dvi_global_settingsUpdateManyMutationInput = {
      ...(dto as any),
      updatedon: new Date(),
      ...(typeof userId === "number" ? { createdby: userId } : {}),
    };

 // If there is no row yet, create one first.
    const existing = await this.prisma.dvi_global_settings.findFirst({
      where: { deleted: 0 },
    });

    if (!existing) {
      await this.prisma.dvi_global_settings.create({
        data: {
          ...(dto as any),
          createdby: typeof userId === "number" ? userId : 0,
          createdon: new Date(),
          updatedon: new Date(),
          status: 1,
          deleted: 0,
        },
      });

      return this.getGlobalSettings();
    }

    await this.prisma.dvi_global_settings.updateMany({
      where: { deleted: 0 },
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
