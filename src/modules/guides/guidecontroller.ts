// FILE: src/modules/guides/guidecontroller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  GuidesService,
  GuideListQueryDto,
  GuideBasicDto,
  GuidePricebookSaveDto,
  GuideReviewSaveDto,
} from './guideservice';

@ApiTags('guides')
@ApiBearerAuth()
@Controller('guides')
export class GuidesController {
  constructor(private readonly guides: GuidesService) {}

  private mapGuideBasicPhpErrors(message: string): Record<string, any> | null {
    const msg = String(message || '');
    if (msg.includes('guide_name is required')) return { guide_name_required: true };
    if (msg.includes('guide_gender is required')) return { guide_gender_required: true };
    if (
      msg.includes('guide_primary_mobile_number is required') ||
      msg.includes('guide_primary_mobile_number must be 10 digits')
    ) {
      return { guide_primary_mobile_no_required: true };
    }
    if (msg.includes('guide_email is required')) return { guide_email_id_required: true };
    if (msg.includes('guide_select_role is required')) return { guide_select_role_required: true };
    if (msg.includes('guide_language_proficiency is required')) {
      return { guide_language_proficiency_required: true };
    }
    if (msg.includes('guide_gst is required') || msg.includes('gst_type is required')) {
      return { guide_gst_required: true };
    }
    if (msg.includes('guide_available_slot is required')) return { guide_slot_required: true };
    if (msg.includes('guide_password is required')) return { guide_password_required: true };
    if (msg.includes('Emergency mobile number and primary mobile number should not be same')) {
      return {
        guide_emergency_mobile_number_same:
          'Emeregency mobile number and primary mobile number should not be same',
      };
    }
    if (msg.includes('Account number')) {
      return { guide_account_no_not_same: 'Account number and confirm account number should be same' };
    }
    return null;
  }

  // ───────────────────────── PHP AJAX compatibility routes ─────────────────────────
  @Get('ajax/list')
  async listAjaxCompat(@Query('page') page?: string, @Query('size') size?: string) {
    const dto: GuideListQueryDto = {
      page: page ? Number(page) : undefined,
      size: size ? Number(size) : undefined,
    };
    return this.guides.list(dto);
  }

  @Post('ajax/check-guide-email')
  async checkGuideEmailCompat(@Body() body: any) {
    const out = await this.guides.checkGuideEmailDuplicate(body ?? {});
    if (out.success) return { success: true };
    return {};
  }

  @Post('ajax/preview')
  async previewAjaxCompat(@Query('type') type?: string, @Body() body?: any) {
    const guideId = Number(body?.ID ?? body?.id ?? 0);
    if (!guideId) throw new BadRequestException('ID is required');

    if (String(type ?? '').toLowerCase() === 'overallpreview') {
      const [preview, options] = await Promise.all([
        this.guides.getPreview(guideId),
        this.guides.formOptions(),
      ]);
      return { preview, options };
    }

    return this.guides.getPreview(guideId);
  }

  @Post('ajax/manage')
  async manageAjaxCompat(@Query('type') type?: string, @Body() body?: any) {
    const action = String(type ?? '').trim().toLowerCase();
    const payload = body ?? {};

    switch (action) {
      case 'guide_basic_info': {
        try {
          const saved = await this.guides.saveFormStep1(payload);
          const guideId = Number(saved?.id ?? payload?.hidden_guide_ID ?? payload?.id ?? 0);
          const isUpdate = Boolean(payload?.hidden_guide_ID ?? payload?.id);
          return {
            success: true,
            result_success: true,
            redirect_URL: `guide.php?route=add&formtype=guide_pricebook&id=${guideId}`,
            ...(isUpdate ? { u_result: true } : { i_result: true }),
          };
        } catch (error: any) {
          const message = String(error?.response?.message ?? error?.message ?? 'Validation failed');
          const mapped = this.mapGuideBasicPhpErrors(message);
          if (!mapped) {
            const isUpdate = Boolean(payload?.hidden_guide_ID ?? payload?.id);
            return {
              success: true,
              result_success: false,
              ...(isUpdate ? { u_result: false } : { i_result: false }),
            };
          }
          return {
            success: false,
            errors: mapped,
          };
        }
      }

      case 'update_guide_status': {
        const guideId = Number(payload?.GUIDE_ID ?? payload?.guide_id ?? 0);
        const statusId = Number(payload?.STATUS_ID ?? payload?.status ?? 0);
        const flipped = statusId === 1 ? 0 : 1;
        await this.guides.toggleStatus(guideId, flipped);
        return { result_success: true };
      }

      case 'confirm_guide_delete': {
        const guideId = Number(payload?._ID ?? payload?.id ?? 0);
        await this.guides.softDelete(guideId);
        return { result: true };
      }

      case 'guide_pricebook': {
        const guideId = Number(payload?.hidden_guide_ID ?? payload?.guide_id ?? 0);
        const startDateRaw = String(payload?.selectstartdate ?? payload?.start_date ?? '');
        const endDateRaw = String(payload?.selectenddate ?? payload?.end_date ?? '');

        const errors: Record<string, boolean> = {};
        if (!guideId) errors.guide_required = true;
        if (!startDateRaw) errors.selectstartdate_required = true;
        if (!endDateRaw) errors.selectenddate_required = true;
        if (Object.keys(errors).length > 0) {
          return { success: false, errors };
        }

        const toIsoDate = (value: string) => {
          const v = String(value).trim();
          const m = v.match(/^(\d{2})-(\d{2})-(\d{4})$/);
          if (m) return `${m[3]}-${m[2]}-${m[1]}`;
          return v;
        };

        const startDate = toIsoDate(startDateRaw);
        const endDate = toIsoDate(endDateRaw);
        const paxTypes = Array.isArray(payload?.pax_type)
          ? payload.pax_type.map((v: any) => Number(v))
          : [];
        const slotTypes = Array.isArray(payload?.pax_slot_type)
          ? payload.pax_slot_type.map((v: any) => Number(v))
          : [];

        const paxPrices: Array<{ pax_id: number; slot_id: number; price: number | string }> = [];
        for (const paxType of paxTypes) {
          const key = `pax${paxType}_slot_price`;
          const keyUnderscore = `_pax${paxType}_slot_price`;
          const prices = Array.isArray(payload?.[key])
            ? payload[key]
            : Array.isArray(payload?.[keyUnderscore])
            ? payload[keyUnderscore]
            : [];
          for (let i = 0; i < slotTypes.length; i++) {
            paxPrices.push({
              pax_id: Number(paxType),
              slot_id: Number(slotTypes[i]),
              price: prices[i] ?? '',
            });
          }
        }

        try {
          await this.guides.savePricebook({
            guide_id: guideId,
            start_date: startDate,
            end_date: endDate,
            pax_prices: paxPrices,
          });
          return { success: true, u_result: true, result_success: true };
        } catch {
          return { success: true, u_result: false, result_success: false };
        }
      }

      case 'guide_feedback': {
        const reviewId = Number(payload?.hidden_guide_review_id ?? payload?.guide_review_id ?? 0);
        const guideId = Number(payload?.hidden_guide_ID ?? payload?.guide_id ?? 0);
        const rating = Number(payload?.guide_rating ?? payload?.rating ?? 0);
        const description = String(payload?.review_description ?? payload?.description ?? '').trim();

        const errors: Record<string, boolean> = {};
        if (!rating) errors.guide_rating_required = true;
        if (!description) errors.guide_description_required = true;
        if (Object.keys(errors).length > 0) {
          return { success: false, errors };
        }

        if (reviewId > 0) {
          try {
            await this.guides.updateReview(reviewId, {
              guide_id: guideId,
              rating,
              description,
            });
            return { success: true, u_result: true, guide_id: guideId, result_success: true };
          } catch {
            return { success: true, u_result: false, result_success: false };
          }
        }
        try {
          await this.guides.addReview({
            guide_id: guideId,
            rating,
            description,
          });
          return { success: true, i_result: true, guide_id: guideId, result_success: true };
        } catch {
          return { success: true, i_result: false, result_success: false };
        }
      }

      case 'confirm_guide_feedback_delete': {
        const reviewId = Number(payload?._ID ?? payload?.guide_review_id ?? payload?.id ?? 0);
        await this.guides.deleteReview(reviewId);
        return { result: true };
      }

      default:
        throw new BadRequestException(`Unsupported type: ${type}`);
    }
  }

  // ───────────────────────────── List (DataTable) ─────────────────────────────
  @Get()
  async list(
    @Query('page') page?: string,
    @Query('size') size?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
  ) {
    const dto: GuideListQueryDto = {
      page: page ? Number(page) : undefined,
      size: size ? Number(size) : undefined,
      q: q ?? undefined,
      status:
        status !== undefined && status !== null && status !== ''
          ? Number(status)
          : undefined,
    };
    return this.guides.list(dto);
  }

  // ───────────────────── Dynamic dropdowns / form options ────────────────────
  @Get('options')
  async formOptions() {
    return this.guides.formOptions();
  }

  // Alias used by current React service
  @Get(':id')
  async getOne(@Param('id', ParseIntPipe) id: number) {
    return this.guides.getById(id);
  }

  // ───────────────────────────── Get form (edit) ─────────────────────────────
  @Get(':id/form')
  async getForm(@Param('id', ParseIntPipe) id: number) {
    return this.guides.getForm(id);
  }

  // ───────────────────────────── Save Step 1 (basic) ─────────────────────────
  // Create (no id in payload) or Update (with id) — mirrors PHP behavior
  @Post()
  async saveFormStep1(@Body() body: GuideBasicDto) {
    return this.guides.saveFormStep1(body);
  }

  // Optional convenience route for explicit update by :id; merges :id into body
  @Put(':id')
  async updateBasic(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: GuideBasicDto,
  ) {
    return this.guides.saveFormStep1({ ...body, id });
  }

  // ───────────────────────────── Save Step 2 (pricebook) ─────────────────────
  @Put(':id/pricebook')
  async savePricebook(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Omit<GuidePricebookSaveDto, 'guide_id'> & { guide_id?: number },
  ) {
    const payload: GuidePricebookSaveDto = {
      guide_id: body.guide_id && body.guide_id > 0 ? body.guide_id : id,
      start_date: body.start_date,
      end_date: body.end_date,
      pax_prices: body.pax_prices ?? [],
    };
    return this.guides.savePricebook(payload);
  }

  // Alias for clients using PATCH
  @Patch(':id/pricebook')
  async patchPricebook(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Omit<GuidePricebookSaveDto, 'guide_id'> & { guide_id?: number },
  ) {
    const payload: GuidePricebookSaveDto = {
      guide_id: body.guide_id && body.guide_id > 0 ? body.guide_id : id,
      start_date: body.start_date,
      end_date: body.end_date,
      pax_prices: body.pax_prices ?? [],
    };
    return this.guides.savePricebook(payload);
  }

  // Composite helper to save pricebook then return preview (to enable Next)
  @Put(':id/pricebook-and-preview')
  async savePricebookAndPreview(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Omit<GuidePricebookSaveDto, 'guide_id'> & { guide_id?: number },
  ) {
    const payload: GuidePricebookSaveDto = {
      guide_id: body.guide_id && body.guide_id > 0 ? body.guide_id : id,
      start_date: body.start_date,
      end_date: body.end_date,
      pax_prices: body.pax_prices ?? [],
    };
    return this.guides.saveFormStep2AndPreview(payload);
  }

  // ───────────────────────────── Step 3 (reviews) ────────────────────────────
  @Post(':id/reviews')
  async addReview(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Omit<GuideReviewSaveDto, 'guide_id'> & { guide_id?: number },
  ) {
    const payload: GuideReviewSaveDto = {
      guide_id: body.guide_id && body.guide_id > 0 ? body.guide_id : id,
      rating: body.rating,
      description: body.description,
    };
    return this.guides.addReview(payload);
  }

  @Put(':id/reviews/:reviewId')
  async updateReview(
    @Param('id', ParseIntPipe) id: number,
    @Param('reviewId', ParseIntPipe) reviewId: number,
    @Body() body: Omit<GuideReviewSaveDto, 'guide_id'>,
  ) {
    const payload: GuideReviewSaveDto = {
      guide_id: id,
      rating: body.rating,
      description: body.description,
    };
    return this.guides.updateReview(reviewId, payload);
  }

  @Get(':id/reviews')
  async listReviews(@Param('id', ParseIntPipe) id: number) {
    return this.guides.listReviews(id);
  }

  @Delete('reviews/:reviewId')
  async deleteReview(@Param('reviewId', ParseIntPipe) reviewId: number) {
    return this.guides.deleteReview(reviewId);
  }

  // Alias for clients using nested resource path
  @Delete(':id/reviews/:reviewId')
  async deleteReviewByGuide(
    @Param('reviewId', ParseIntPipe) reviewId: number,
  ) {
    return this.guides.deleteReview(reviewId);
  }

  // ───────────────────────────── Step 4 (preview) ────────────────────────────
  @Get(':id/preview')
  async getPreview(@Param('id', ParseIntPipe) id: number) {
    return this.guides.getPreview(id);
  }

  /**
   * NEW: One-shot payload for the React Preview page (mirrors PHP overall preview flow).
   * Returns:
   * {
   *   preview: { basic, reviews, slots[], preferredFor[] },
   *   options: { states[], genders[], bloodGroups[], guideSlots[], languages[], gst[] }
   * }
   */
  @Get(':id/preview-page')
  async getPreviewPage(@Param('id', ParseIntPipe) id: number) {
    const [preview, options] = await Promise.all([
      this.guides.getPreview(id),
      this.guides.formOptions(),
    ]);
    return { preview, options };
  }

  /**
   * NEW alias using PHP-ish naming so you can hit /guides/:id/overallpreview
   * if your old client code expects that route. Same response as /preview-page.
   */
  @Get(':id/overallpreview')
  async getOverallPreview(@Param('id', ParseIntPipe) id: number) {
    const [preview, options] = await Promise.all([
      this.guides.getPreview(id),
      this.guides.formOptions(),
    ]);
    return { preview, options };
  }

  // ───────────────────────────── status / delete ─────────────────────────────
  @Patch(':id/status')
  async toggleStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body('status') status: number,
  ) {
    return this.guides.toggleStatus(id, Number(status));
  }

  @Delete(':id')
  async softDelete(@Param('id', ParseIntPipe) id: number) {
    return this.guides.softDelete(id);
  }

  // ───────────────────────────── Dropdown Data (Controller) ─────────────────────────────

@Get('dropdowns/roles')
async getRolesDropdown() {
  return this.guides.getRolesDropdown();
}

@Get('dropdowns/languages')
async getLanguagesDropdown() {
  return this.guides.getLanguagesDropdown();
}

@Get('dropdowns/countries')
async getCountriesDropdown() {
  return this.guides.getCountriesDropdown();
}

/** Dependent: states by countryId */
@Get('dropdowns/states')
async getStatesDropdown(@Query('countryId') countryId?: string) {
  return this.guides.getStatesDropdown(Number(countryId));
}

/** Dependent: cities by stateId */
@Get('dropdowns/cities')
async getCitiesDropdown(@Query('stateId') stateId?: string) {
  return this.guides.getCitiesDropdown(Number(stateId));
}

/** GST types: Included(1), Excluded(2) */
@Get('dropdowns/gst-types')
async getGstTypesDropdown() {
  return this.guides.getGstTypesDropdown();
}

/** GST% list from dvi_gst_setting.gst_title */
@Get('dropdowns/gst-percentages')
async getGstPercentagesDropdown() {
  return this.guides.getGstPercentagesDropdown();
}

/** Hotspot places from dvi_hotspot_place.hotspot_name */
@Get('dropdowns/hotspots')
async getHotspotPlacesDropdown() {
  return this.guides.getHotspotPlacesDropdown();
}

/** Activities from dvi_activity.activity_title */
@Get('dropdowns/activities')
async getActivitiesDropdown() {
  return this.guides.getActivitiesDropdown();
}

/**
 * One-shot fetch for all dropdowns.
 * Optional query params: countryId (to scope states), stateId (to scope cities)
 * Example:
 *   GET /guides/dropdowns/all?countryId=101&stateId=33
 */
@Get('dropdowns/all')
async getAllDropdowns(
  @Query('countryId') countryId?: string,
  @Query('stateId') stateId?: string,
) {
  return this.guides.getAllDropdowns({
    countryId: countryId ? Number(countryId) : undefined,
    stateId: stateId ? Number(stateId) : undefined,
  });
}
}
