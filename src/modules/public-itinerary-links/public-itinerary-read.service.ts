import {
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';

import { PrismaService } from '../../prisma.service';
import { SystemRole } from '../auth/constants/system-role.constants';
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

const [
  itinerary,
  hotelDetails,
  agentConfig,
  agentDetails,
  creatorUser,
] = await Promise.all([
  this.itineraryDetailsService.getItineraryDetails(
    plan.itinerary_quote_ID,
    link.groupType,
  ),

  this.itineraryHotelDetailsService
    .getHotelDetailsByQuoteId(
      plan.itinerary_quote_ID,
    )
    .catch(() => null),

Number(plan.agent_id || 0) > 0
  ? this.prisma.dvi_agent_configuration.findMany({
      where: {
        agent_id: Number(
          plan.agent_id,
        ),
        deleted: 0,
      },
      select: {
        site_logo: true,
        company_name: true,
        site_address: true,
        invoice_address: true,
        status: true,
      },
      orderBy: [
        {
          status: "desc",
        },
        {
          agent_config_id: "desc",
        },
      ],
    })
  : Promise.resolve([]),

Number(plan.agent_id || 0) > 0
  ? this.prisma.dvi_agent.findFirst({
      where: {
        agent_ID: Number(
          plan.agent_id,
        ),
        deleted: 0,
      },
      select: {
        agent_name: true,
        agent_lastname: true,
        agent_email_id: true,
        agent_primary_mobile_number: true,

        agent_country: true,
        agent_state: true,
        agent_city: true,
      },
    })
  : Promise.resolve(null),

  Number(link.createdByUserId || 0) > 0
    ? this.prisma.dvi_users.findUnique({
        where: {
          userID: Number(
            link.createdByUserId,
          ),
        },
        select: {
          roleID: true,
        },
      })
    : Promise.resolve(null),
]);

const source = itinerary as any;
const [
  agentCountry,
  agentState,
  agentCity,
] = await Promise.all([
  Number(
    agentDetails?.agent_country || 0,
  ) > 0
    ? this.prisma.dvi_countries.findFirst({
        where: {
          id: Number(
            agentDetails?.agent_country,
          ),
        },
        select: {
          name: true,
        },
      })
    : Promise.resolve(null),

  Number(
    agentDetails?.agent_state || 0,
  ) > 0
    ? this.prisma.dvi_states.findFirst({
        where: {
          id: Number(
            agentDetails?.agent_state,
          ),
        },
        select: {
          name: true,
        },
      })
    : Promise.resolve(null),

  Number(
    agentDetails?.agent_city || 0,
  ) > 0
    ? this.prisma.dvi_cities.findFirst({
        where: {
          id: Number(
            agentDetails?.agent_city,
          ),
        },
        select: {
          name: true,
        },
      })
    : Promise.resolve(null),
]);

const agentLocationAddress =
  [
    String(
      agentCity?.name || "",
    ).trim(),

    String(
      agentState?.name || "",
    ).trim(),

    String(
      agentCountry?.name || "",
    ).trim(),
  ]
    .filter(Boolean)
    .join(", ");

const vehicleCost = Number(
  source.costBreakdown?.totalVehicleAmount ??
    source.costBreakdown?.totalVehicleCost ??
    0,
);

const agentLogo =
  agentConfig
    .map((config) =>
      String(
        config?.site_logo || "",
      ).trim(),
    )
    .find(Boolean) || "";

const activeAgentConfig =
  agentConfig.find(
    (config) =>
      Number(
        config?.status || 0,
      ) === 1,
  ) ??
  agentConfig[0] ??
  null;

const agentCompanyName =
  String(
    activeAgentConfig?.company_name ||
      "",
  ).trim() ||
  [
    String(
      agentDetails?.agent_name || "",
    ).trim(),

    String(
      agentDetails?.agent_lastname || "",
    ).trim(),
  ]
    .filter(Boolean)
    .join(" ");

const agentSiteAddress =
  String(
    activeAgentConfig?.site_address ||
      "",
  ).trim();

const agentInvoiceAddress =
  String(
    activeAgentConfig?.invoice_address ||
      "",
  ).trim();

const agentAddress =
  agentSiteAddress ||
  agentInvoiceAddress ||
  agentLocationAddress;

const creatorRoleId =
  Number(
    creatorUser?.roleID || 0,
  );

const showAgentFooter =
  creatorRoleId ===
    SystemRole.AGENT ||
  creatorRoleId ===
    SystemRole.TRAVEL_EXPERT ||
  (
    creatorRoleId === 0 &&
    Number(
      link.createdByAgentId || 0,
    ) > 0
  );
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

 agentDetails:
  showAgentFooter
    ? {
        companyName:
          agentCompanyName ||
          null,

        email:
          String(
            agentDetails
              ?.agent_email_id ||
              "",
          ).trim() || null,

        contactNo:
          String(
            agentDetails
              ?.agent_primary_mobile_number ||
              "",
          ).trim() || null,

        address:
          agentAddress ||
          null,
      }
    : null,

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

          /*
           * IMPORTANT:
           * Use hotelSelectionState as the source of truth.
           *
           * These routes represent the actual itinerary
           * days on which a hotel stay is required.
           *
           * Example:
           * 2 Nights / 3 Days
           *
           * Day 1 -> hotel
           * Day 2 -> hotel
           * Day 3 -> departure, no hotel
           */
          const selectionGroup =
            Array.isArray(
              hotelDetails
                ?.hotelSelectionState,
            )
              ? hotelDetails
                  .hotelSelectionState
                  .find(
                    (
                      group: any,
                    ) =>
                      Number(
                        group
                          ?.groupType ||
                          0,
                      ) ===
                      groupType,
                  )
              : null;

          /*
           * Same route metadata used by
           * the normal Hotel List.
           *
           * Gives us:
           * routeId
           * dayNumber
           * date
           * destination
           */
          const stayRoutes =
            Array.isArray(
              hotelDetails
                ?.hotelAvailability
                ?.stayRoutes,
            )
              ? hotelDetails
                  .hotelAvailability
                  .stayRoutes
              : [];

          /*
           * Raw group hotels are only a
           * fallback for display identity.
           *
           * They are NOT used to decide
           * how many hotel days exist.
           */
          const rawGroupHotels =
            Array.isArray(
              hotelDetails?.hotels,
            )
              ? hotelDetails.hotels.filter(
                  (
                    hotel: any,
                  ) =>
                    Number(
                      hotel
                        ?.groupType ||
                        0,
                    ) ===
                    groupType,
                )
              : [];

          /*
           * Primary source:
           * authoritative selected hotel routes.
           */
          const selectionRoutes =
            Array.isArray(
              selectionGroup?.routes,
            )
              ? selectionGroup.routes
              : [];

          /*
           * Normally selectionRoutes will exist.
           *
           * Safe fallback:
           * use only hotel stay routes and
           * never exceed itinerary night count.
           */
          const hotelRoutes =
            selectionRoutes.length > 0
              ? selectionRoutes
              : stayRoutes
                  .slice(
                    0,
                    Math.max(
                      0,
                      Number(
                        source
                          .nightCount ||
                          0,
                      ),
                    ),
                  )
                  .map(
                    (
                      route: any,
                    ) => ({
                      routeId:
                        Number(
                          route
                            ?.routeId ||
                            0,
                        ),

                      routeDate:
                        route
                          ?.date ??
                        route
                          ?.routeDate ??
                        null,

                      selected:
                        null,
                    }),
                  );

          const hotels =
            hotelRoutes.map(
              (
                route: any,
                index: number,
              ) => {
                const routeId =
                  Number(
                    route
                      ?.routeId ||
                      0,
                  );

                const routeMeta =
                  stayRoutes.find(
                    (
                      item: any,
                    ) =>
                      Number(
                        item
                          ?.routeId ||
                          0,
                      ) ===
                      routeId,
                  );

                const routeDate =
                  String(
                    route
                      ?.routeDate ??
                      routeMeta
                        ?.date ??
                      routeMeta
                        ?.routeDate ??
                      "",
                  ).slice(
                    0,
                    10,
                  );

                /*
                 * Find the matching itinerary
                 * day only for metadata fallback.
                 */
                const itineraryDay =
                  Array.isArray(
                    source.days,
                  )
                    ? source.days.find(
                        (
                          day: any,
                        ) =>
                          (
                            routeId >
                              0 &&
                            Number(
                              day?.id ||
                                0,
                            ) ===
                              routeId
                          ) ||
                          (
                            Boolean(
                              routeDate,
                            ) &&
                            String(
                              day?.date ||
                                "",
                            ).slice(
                              0,
                              10,
                            ) ===
                              routeDate
                          ),
                      )
                    : null;

                /*
                 * Raw hotel fallback.
                 *
                 * Important:
                 * routeIds / completeStayRouteIds
                 * may represent a multi-night stay.
                 */
                const rawHotel =
                  rawGroupHotels.find(
                    (
                      hotel: any,
                    ) => {
                      const coveredRouteIds =
                        [
                          Number(
                            hotel
                              ?.itineraryRouteId ||
                              hotel
                                ?.routeId ||
                              0,
                          ),

                          ...(
                            Array.isArray(
                              hotel
                                ?.routeIds,
                            )
                              ? hotel.routeIds
                              : []
                          ).map(
                            (
                              id: unknown,
                            ) =>
                              Number(
                                id,
                              ),
                          ),

                          ...(
                            Array.isArray(
                              hotel
                                ?.completeStayRouteIds,
                            )
                              ? hotel
                                  .completeStayRouteIds
                              : []
                          ).map(
                            (
                              id: unknown,
                            ) =>
                              Number(
                                id,
                              ),
                          ),
                        ].filter(
                          (
                            id: number,
                          ) =>
                            id > 0,
                        );

                      return coveredRouteIds.includes(
                        routeId,
                      );
                    },
                  );

                /*
                 * Prefer the authoritative selected
                 * identity from hotelSelectionState.
                 *
                 * Fall back to raw hotel row only
                 * when necessary.
                 */
                const selectedHotel =
                  route?.selected ??
                  rawHotel ??
                  {};

                const dayNumber =
                  Number(
                    routeMeta
                      ?.dayNumber ??
                      itineraryDay
                        ?.dayNumber ??
                      0,
                  );

                const date =
                  String(
                    route
                      ?.routeDate ??
                      routeMeta
                        ?.date ??
                      routeMeta
                        ?.routeDate ??
                      itineraryDay
                        ?.date ??
                      rawHotel
                        ?.date ??
                      "",
                  ).slice(
                    0,
                    10,
                  );

              /*
 * Resolve the actual HOTEL STAY destination.
 *
 * Recommendation stayResults are authoritative
 * because one stay can cover one or multiple
 * itinerary route IDs.
 */
const matchingStay =
  Array.isArray(
    tab?.stayResults,
  )
    ? tab.stayResults.find(
        (stay: any) => {
          const coveredRouteIds =
            [
              Number(
                stay?.parentRouteId ||
                  0,
              ),

              ...(
                Array.isArray(
                  stay?.routeIds,
                )
                  ? stay.routeIds
                  : []
              ).map(
                (
                  id: unknown,
                ) =>
                  Number(id),
              ),
            ].filter(
              (
                id: number,
              ) =>
                id > 0,
            );

          return coveredRouteIds.includes(
            routeId,
          );
        },
      )
    : null;

const destination =
  String(
    matchingStay
      ?.destination ??
      "",
  ).trim() ||
  String(
    itineraryDay
      ?.arrival ??
      "",
  ).trim() ||
  String(
    rawHotel
      ?.destination ??
      "",
  ).trim() ||
  String(
    routeMeta
      ?.destination ??
      "",
  ).trim();

                return {
                  day:
                    dayNumber > 0
                      ? `Day ${dayNumber}`
                      : `Day ${
                          index + 1
                        }`,

                  date:
                    date ||
                    null,

                  destination:
                    destination ||
                    null,

                  hotelName:
                    selectedHotel
                      ?.hotelName ??
                    null,

                  category:
                    selectedHotel
                      ?.selectedCategory ??
                    selectedHotel
                      ?.category ??
                    null,

                  roomType:
                    selectedHotel
                      ?.roomType ??
                    null,

                  mealPlan:
                    selectedHotel
                      ?.mealPlan ??
                    null,

                  totalAmount:
                    Number(
                      selectedHotel
                        ?.selectedTotalPrice ??
                        selectedHotel
                          ?.totalPrice ??
                        selectedHotel
                          ?.totalStayPrice ??
                        selectedHotel
                          ?.totalHotelCost ??
                        0,
                    ),
                };
              },
            );

          /*
           * Use the authoritative package total
           * from the same hotel-selection state.
           *
           * Fallback to the recommendation tab
           * total for old data.
           */
        const hotelTotal =
  Number(
    tab?.totalAmount ??
      selectionGroup
        ?.totalAmount ??
      0,
  );

return {
  groupType,

  label:
    tab?.label ??
    `Recommended #${groupType}`,

  totalAmount:
    hotelTotal,

  vehicleCost,

  hotelCost:
    hotelTotal,

  totalPackageCost:
    Number(
      (
        hotelTotal +
        vehicleCost
      ).toFixed(2),
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