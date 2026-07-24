import { Controller, Get, Logger, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/public.decorator';
import { ItineraryScenarioSourceService } from './itinerary-scenario-source.service';

@ApiTags('Itinerary Scenario Source')
@ApiBearerAuth()
@Controller('itineraries')
export class ItineraryScenarioSourceController {
  private readonly logger = new Logger(ItineraryScenarioSourceController.name);

  constructor(private readonly sourceService: ItineraryScenarioSourceService) {}

  @Get('hotspot-scenario-md/:quoteId')
  @Public()
  @ApiOperation({
    summary: 'Return live-generated markdown for a quote/day hotspot scenario',
    description:
      'Generates the hotspot scenario text from the current database state on every request.',
  })
  @ApiParam({ name: 'quoteId', example: 'DVI20260798' })
  @ApiQuery({ name: 'day', required: false, example: 2, description: 'Optional day number' })
  async getScenarioMarkdown(
    @Param('quoteId') quoteId: string,
    @Query('day') day?: string,
  ) {
    const dayNo = day == null || String(day).trim() === '' ? undefined : Number(day);
    const normalizedDayNo = dayNo != null && Number.isFinite(dayNo) ? dayNo : undefined;
 this.logger.log(`Loading hotspot scenario markdown for quote=${quoteId} day=${normalizedDayNo 'all'}`);

    return this.sourceService.getScenarioMarkdown(quoteId, normalizedDayNo);
  }
}
