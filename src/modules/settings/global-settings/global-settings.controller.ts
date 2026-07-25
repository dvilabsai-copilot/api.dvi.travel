// FILE: src/modules/global-settings/global-settings.controller.ts

import {
  Controller,
  Get,
  Put,
  Body,
  Query,
  ParseIntPipe,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { GlobalSettingsService } from "./global-settings.service";
import { UpdateGlobalSettingsDto } from "./dto/update-global-settings.dto";
import { StateConfigUpdateDto } from "./dto/state-config.dto";

@ApiTags("global-settings")
@ApiBearerAuth()
@Controller("global-settings")
export class GlobalSettingsController {
  constructor(private readonly service: GlobalSettingsService) {}

 /**
   * GET /global-settings
   * Returns the single global settings row (like global_settings.php initial load).
 */
  @Get()
  getGlobalSettings() {
    return this.service.getGlobalSettings();
  }

 /**
   * PUT /global-settings
   * Body = all fields from the React GlobalSettings form.
   * Mirrors __ajax_manage_global_setting.php for saving config.
 */
  @Put()
  updateGlobalSettings(
    @Body() dto: UpdateGlobalSettingsDto,
 // if you have auth, inject user from request and pass user.id into service
  ) {
 return this.service.updateGlobalSettings(dto /*, userId */);
  }

 /**
   * GET /global-settings/state-config?stateId=XX
   * Fetches on-ground & escalation numbers for a given state.
   * Mirrors __ajax_fetch_state_config.php.
 */
  @Get("state-config")
  getStateConfig(
    @Query("stateId", ParseIntPipe) stateId: number,
  ) {
    return this.service.getStateConfig(stateId);
  }

 /**
   * PUT /global-settings/state-config
   * Body: { stateId, vehicleOngroundSupportNumber?, vehicleEscalationCallNumber? }
   * Mirrors __ajax_manage_global_setting.php (state config update branch).
 */
  @Put("state-config")
  updateStateConfig(
    @Body() dto: StateConfigUpdateDto,
  ) {
    return this.service.updateStateConfig(dto);
  }

 /**
   * GET /global-settings/states?countryId=101
   * Convenience endpoint for Global Settings screen to populate State dropdown.
   * If countryId is missing/invalid, service will default to India (country_id = 101).
 */
  @Get("states")
  listStates(@Query("countryId") countryId?: string) {
    const cid = countryId ? parseInt(countryId, 10) : undefined;
    const normalized =
      cid !== undefined && !Number.isNaN(cid) ? cid : undefined;

    return this.service.listStatesByCountry(normalized);
  }

  @Get("countries")
  listCountries() {
    return this.service.listCountries();
  }
}
