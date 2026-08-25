import {
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';

import { PrismaService } from '../../prisma.service';
import { ItineraryDetailsService } from '../itineraries/itinerary-details.service';
import { ItineraryHotelDetailsService } from '../itineraries/itinerary-hotel-details.service';

@Injectable()
export class PublicItineraryReadService {
constructor(
  private readonly prisma: PrismaService,
  private readonly itineraryDetailsService: ItineraryDetailsService,
  private readonly itineraryHotelDetailsService: ItineraryHotelDetailsService,
) {}

private hashToken(token: string): string {
  return createHash('sha256')
    .update(token)
    .digest('hex');
}

private richTextToPlainText(value: unknown): string {
  let text = String(value ?? '').trim();

  if (!text) {
    return '';
  }

  for (let index = 0; index < 2; index += 1) {
    text = text
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#(?:39|x27);/gi, "'");
  }

  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async resolvePublicItinerary(rawToken: string) {
    const token = String(rawToken || '').trim();

    if (
      !token ||
      token.length < 32 ||
      token.length > 200 ||
      !/^[A-Za-z0-9_-]+$/.test(token)
    ) {
      throw new NotFoundException(
        'This itinerary link is not available.',
      );
    }

    const tokenHash = this.hashToken(token);

    const link =
      await this.prisma.public_itinerary_links.findUnique({
        where: {
          tokenHash,
        },
      });

    if (!link) {
      throw new NotFoundException(
        'This itinerary link is not available.',
      );
    }

    const now = new Date();

    if (
      link.revokedAt ||
      link.expiresAt.getTime() <= now.getTime()
    ) {
      throw new GoneException(
        'This itinerary link has expired. Please request a new link.',
      );
    }

const plan =
  await this.prisma.dvi_itinerary_plan_details.findFirst({
    where: {
      itinerary_plan_ID: link.itineraryPlanId,
      deleted: 0,
    },
    select: {
      itinerary_plan_ID: true,
      itinerary_quote_ID: true,
      quotation_status: true,
      agent_id: true,
    },
  });

    if (!plan || Number(plan.quotation_status) === 2) {
      throw new NotFoundException(
        'This itinerary link is not available.',
      );
    }

const [itinerary, hotelDetails, agentConfig] = await Promise.all([
  this.itineraryDetailsService.getItineraryDetails(
    plan.itinerary_quote_ID,
    link.groupType,
  ),

  this.itineraryHotelDetailsService
    .getHotelDetailsByQuoteId(
      plan.itinerary_quote_ID,
    )
    .catch(() => null),

Number(link.createdByAgentId || 0) > 0
  ? this.prisma.dvi_agent_configuration.findMany({
      where: {
        agent_id: Number(
          link.createdByAgentId,
        ),
        status: 1,
        deleted: 0,
      },
      select: {
        site_logo: true,
      },
      orderBy: {
        agent_config_id: "desc",
      },
    })
  : Promise.resolve([]),
]);

const source = itinerary as any;

const agentLogo =
  agentConfig
    .map((config) =>
      String(
        config?.site_logo || "",
      ).trim(),
    )
    .find(Boolean) || "";
const globalSettings =
  await this.prisma.dvi_global_settings.findFirst({
    where: {
      deleted: 0,
      status: 1,
    },
    orderBy: {
      global_settings_ID: 'asc',
    },
    select: {
      hotel_terms_condition: true,
    },
  });

const packageTerms = this.richTextToPlainText(
  globalSettings?.hotel_terms_condition ??
    source.packageIncludes?.description ??
    '',
);

const publicItinerary = {
  quoteId: source.quoteId,
  dateRange: source.dateRange,

  agentLogo:
    agentLogo || null,

  dayCount: source.dayCount,
  nightCount: source.nightCount,

  roomCount: source.roomCount,
  extraBed: source.extraBed,
  childWithBed: source.childWithBed,
  childWithoutBed: source.childWithoutBed,

  adults: source.adults,
  children: source.children,
  infants: source.infants,

  itineraryPreference:
    source.itineraryPreference,

  itineraryType:
    source.itineraryType,

  guideForItinerary:
    source.guideForItinerary,

  mealPlanCode:
    source.meal_plan_code ?? null,

  foodPreference:
    source.guestFoodPreference ??
    source.guest_food_preference ??
    source.foodTypeName ??
    source.food_type_name ??
    null,

  specialInstructions:
    source.specialInstructions ??
    source.special_instructions ??
    source.specialInstruction ??
    source.special_instruction ??
    null,

  overallCost:
    source.overallCost,

  finalTotal:
    source.costBreakdown?.netPayable ??
    source.overallCost ??
    0,

  /*
   * PUBLIC DAY-WISE ITINERARY
   *
   * Important:
   * internal "Click to Add Hotspot" placeholders
   * are deliberately excluded.
   */
  days: Array.isArray(source.days)
    ? source.days.map((day: any) => ({
        id: Number(day?.id || 0),

        dayNumber:
          Number(day?.dayNumber || 0),

        date:
          day?.date ?? null,

        departure:
          day?.departure ?? null,

        arrival:
          day?.arrival ?? null,

        distance:
          day?.distance ?? null,

        intercityDistance:
          day?.intercityDistance ?? null,

        sightseeingDistance:
          day?.sightseeingDistance ?? null,

        startTime:
          day?.startTime ?? null,

        endTime:
          day?.endTime ?? null,

        departureTime:
          day?.departureTime ?? null,

        viaRoutes:
          Array.isArray(day?.viaRoutes)
            ? day.viaRoutes.map(
                (route: any) => ({
                  id: Number(
                    route?.id || 0,
                  ),

                  name: String(
                    route?.name || '',
                  ),
                }),
              )
            : [],

        segments:
          Array.isArray(day?.segments)
            ? day.segments
                .filter(
                  (segment: any) =>
                    String(
                      segment?.type || '',
                    ).toLowerCase() !==
                    'hotspot',
                )
                .map(
                  (segment: any) => ({
                    type:
                      segment?.type ?? null,

                    title:
                      segment?.title ?? null,

                    text:
                      segment?.text ?? null,

                    from:
                      segment?.from ?? null,

                    to:
                      segment?.to ?? null,

                    location:
                      segment?.location ??
                      null,

                    name:
                      segment?.name ?? null,

                    description:
                      segment?.description ??
                      null,

                    hotelName:
                      segment?.hotelName ??
                      null,

                    hotelAddress:
                      segment?.hotelAddress ??
                      null,

                    time:
                      segment?.time ?? null,

                    timeRange:
                      segment?.timeRange ??
                      null,

                    visitTime:
                      segment?.visitTime ??
                      null,

                    duration:
                      segment?.duration ??
                      null,

                    distance:
                      segment?.distance ??
                      null,

                    amount:
                      segment?.amount ?? null,

                    timings:
                      segment?.timings ??
                      null,

                    image:
                      segment?.image ?? null,

                    galleryImages:
                      Array.isArray(
                        segment
                          ?.galleryImages,
                      )
                        ? segment.galleryImages
                        : [],

                    videoUrl:
                      segment?.videoUrl ??
                      null,

                    note:
                      segment?.note ?? null,

                    activities:
                      Array.isArray(
                        segment
                          ?.activities,
                      )
                        ? segment.activities.map(
                            (
                              activity: any,
                            ) => ({
                              id: Number(
                                activity
                                  ?.id || 0,
                              ),

                              title:
                                activity
                                  ?.title ??
                                '',

                              description:
                                activity
                                  ?.description ??
                                '',

                              amount:
                                Number(
                                  activity
                                    ?.amount ||
                                    0,
                                ),

                              startTime:
                                activity
                                  ?.startTime ??
                                null,

                              endTime:
                                activity
                                  ?.endTime ??
                                null,

                              duration:
                                activity
                                  ?.duration ??
                                null,

                              image:
                                activity
                                  ?.image ??
                                null,
                            }),
                          )
                        : [],
                  }),
                )
            : [],
      }))
    : [],

  /*
   * HOTEL RECOMMENDATION DATA.
   *
   * Only customer-facing information is exposed.
   * Provider IDs, margins, supplier codes etc.
   * are intentionally NOT returned.
   */
  selectedHotelGroup:
    Number(link.groupType || 1),

  hotelGroups:
    Array.isArray(
      hotelDetails?.hotelTabs,
    )
      ? hotelDetails.hotelTabs.map(
          (tab: any) => {
            const groupType =
              Number(
                tab?.groupType || 0,
              );

            const hotels =
              Array.isArray(
                hotelDetails?.hotels,
              )
                ? hotelDetails.hotels
                    .filter(
                      (hotel: any) =>
                        Number(
                          hotel
                            ?.groupType ||
                            0,
                        ) ===
                        groupType,
                    )
                    .map(
                      (
                        hotel: any,
                      ) => ({
                        day:
                          hotel?.day ??
                          null,

                        date:
                          hotel?.date ??
                          null,

                        destination:
                          hotel
                            ?.destination ??
                          null,

                        hotelName:
                          hotel
                            ?.hotelName ??
                          null,

                        category:
                          hotel
                            ?.category ??
                          null,

                        roomType:
                          hotel
                            ?.roomType ??
                          null,

                        mealPlan:
                          hotel
                            ?.mealPlan ??
                          null,

                        totalAmount:
                          Number(
                            hotel
                              ?.totalStayPrice ??
                              hotel
                                ?.totalHotelCost ??
                              0,
                          ),
                      }),
                    )
                : [];

            return {
              groupType,

              label:
                tab?.label ??
                `Recommended #${groupType}`,

              totalAmount:
                Number(
                  tab?.totalAmount ??
                    0,
                ),

              hotels,
            };
          },
        )
      : [],

 /*
 * PACKAGE INCLUSIONS
 */
packageIncludes: {
  description: packageTerms,
  houseBoatNote: '',
  rateNote: '',
},
  /*
   * CUSTOMER-FACING FINAL COST ONLY.
   * No internal margins/vendor costing.
   */
  costSummary: {
    totalAmount:
      Number(
        source.costBreakdown
          ?.totalAmount ??
          source.overallCost ??
          0,
      ),

    totalRoundOff:
      Number(
        source.costBreakdown
          ?.totalRoundOff ?? 0,
      ),

    netPay:
      Number(
        source.costBreakdown
          ?.netPayable ??
          source.overallCost ??
          0,
      ),
  },
};

    await this.prisma.$transaction([
      this.prisma.public_itinerary_links.update({
        where: {
          id: link.id,
        },
        data: {
          accessCount: {
            increment: 1,
          },
          lastAccessedAt: now,
        },
      }),

      this.prisma.public_itinerary_links.updateMany({
        where: {
          id: link.id,
          firstAccessedAt: null,
        },
        data: {
          firstAccessedAt: now,
        },
      }),
    ]);

    return {
      itinerary: publicItinerary,
      expiresAt: link.expiresAt.toISOString(),
    };
  }
}