import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import * as scenarioBuilder from '../../../scripts/analyze-itinerary-hotspot-scenarios';

type ScenarioSourceResult = {
  quoteId: string;
  dayNo: number | null;
  markdown: string;
  sourceFile: string;
  heading: string;
};

@Injectable()
export class ItineraryScenarioSourceService {
  constructor(private readonly prisma: PrismaService) {}

  async getScenarioMarkdown(quoteId: string, dayNo?: number): Promise<ScenarioSourceResult> {
    const normalizedQuoteId = String(quoteId || '').trim();
    if (!normalizedQuoteId) {
      throw new Error('Quote ID is required.');
    }

    const normalizedDayNo = Number.isInteger(dayNo as number) && Number(dayNo) > 0 ? Number(dayNo) : undefined;
    const scenarioLabel = normalizedDayNo
      ? `Source Preview - ${normalizedQuoteId} Day ${normalizedDayNo}`
      : `Source Preview - ${normalizedQuoteId}`;

    let markdown: string;
    try {
      const generator = (scenarioBuilder as any).default ?? scenarioBuilder;
      markdown = await generator.buildScenarioMarkdown(
        normalizedQuoteId,
        scenarioLabel,
        normalizedDayNo ? { dayNo: normalizedDayNo } : undefined,
        this.prisma as any,
      );
    } catch (error: any) {
      const message = String(error?.message || error || '');
      if (/not found|does not exist/i.test(message)) {
        throw new NotFoundException(message);
      }
      throw error;
    }

    return {
      quoteId: normalizedQuoteId,
      dayNo: normalizedDayNo ?? null,
      markdown,
      sourceFile: 'live-db-generator',
      heading: scenarioLabel,
    };
  }
}
