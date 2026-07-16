type DateInput = string | Date | null | undefined;

export class ItineraryLatestDataTableService {
  constructor(
    private readonly prisma: any,
    private readonly parseDate: (value?: DateInput) => Date | null,
    private readonly startOfDay: (date: Date) => Date,
    private readonly endOfDay: (date: Date) => Date,
    private readonly formatTripDateTime: (value?: DateInput) => string | null,
    private readonly formatCreatedOn: (value?: DateInput) => string,
  ) {}

  async get(q: any, req: any) {
    const rawQuery: any = (req as any)?.query ?? {};

    const searchValue =
      (rawQuery.search &&
        (rawQuery.search.value ?? rawQuery.search['value'])) ||
      rawQuery['search[value]'] ||
      '';

    const draw = Number(q.draw ?? rawQuery.draw ?? 0) || 0;
    const start = Number(q.start ?? rawQuery.start ?? 0) || 0;
    const limit = Number(q.length ?? rawQuery.length ?? 10) || 10;

    const startDateRaw = this.parseDate(
      q.start_date ?? rawQuery.start_date ?? null,
    );
    const endDateRaw = this.parseDate(
      q.end_date ?? rawQuery.end_date ?? null,
    );

    const startDate = startDateRaw ? this.startOfDay(startDateRaw) : null;
    const endDate = endDateRaw ? this.endOfDay(endDateRaw) : null;

    const source_location = String(
      q.source_location ?? rawQuery.source_location ?? '',
    ).trim();
    const destination_location = String(
      q.destination_location ?? rawQuery.destination_location ?? '',
    ).trim();

    const filter_agent_id =
      Number(q.agent_id ?? rawQuery.agent_id ?? 0) || 0;
    const filter_staff_id =
      Number(q.staff_id ?? rawQuery.staff_id ?? 0) || 0;

    const u: any = (req as any).user ?? {};
    const logged_user_level =
      Number(u.roleID ?? u.roleId ?? u.role ?? 0) || 0;
    const input_staff_id = Number(u.staff_id ?? u.staffId ?? 0) || 0;
    const input_agent_id = Number(u.agent_id ?? u.agentId ?? 0) || 0;

    const s = String(searchValue ?? '').trim();

    let roleOr: any | null = null;

    if (input_staff_id > 0 && logged_user_level !== 6) {
      const teAgents = await this.prisma.dvi_agent.findMany({
        where: {
          travel_expert_id: input_staff_id,
        } as any,
        select: { agent_ID: true },
      });
      const teAgentIds = teAgents
        .map((a) => Number(a.agent_ID))
        .filter((n) => n > 0);

      roleOr = {
        OR: [
          { staff_id: input_staff_id },
          ...(teAgentIds.length ? [{ agent_id: { in: teAgentIds } }] : []),
        ],
      };
    } else if (input_agent_id > 0) {
      const agentStaff = await this.prisma.dvi_staff_details.findMany({
        where: {
          agent_id: input_agent_id,
        } as any,
        select: { staff_id: true },
      });
      const agentStaffIds = agentStaff
        .map((x) => Number(x.staff_id))
        .filter((n) => n > 0);

      roleOr = {
        OR: [
          { agent_id: input_agent_id },
          ...(agentStaffIds.length ? [{ staff_id: { in: agentStaffIds } }] : []),
        ],
      };
    }

    let searchOr: any[] = [];
    if (s) {
      const staffMatches = await this.prisma.dvi_staff_details.findMany({
        where: {
          staff_name: { contains: s },
        } as any,
        select: { staff_id: true },
        take: 500,
      });
      const staffIdsByName = staffMatches
        .map((x) => Number(x.staff_id))
        .filter((n) => n > 0);

      const agentMatches = await this.prisma.dvi_agent.findMany({
        where: {
          agent_name: { contains: s },
        } as any,
        select: { agent_ID: true },
        take: 500,
      });
      const agentIdsByName = agentMatches
        .map((x) => Number(x.agent_ID))
        .filter((n) => n > 0);

      const userMatches = await this.prisma.dvi_users.findMany({
        where: {
          OR: [
            { username: { contains: s } },
            ...(staffIdsByName.length
              ? [{ staff_id: { in: staffIdsByName } }]
              : []),
            ...(agentIdsByName.length
              ? [{ agent_id: { in: agentIdsByName } }]
              : []),
          ],
        } as any,
        select: { userID: true },
        take: 1000,
      });
      const userIdsBySearch = userMatches
        .map((x) => Number(x.userID))
        .filter((n) => n > 0);

      const confirmedMatches =
        await this.prisma.dvi_confirmed_itinerary_plan_details.findMany(
          {
            where: {
              deleted: 0,
              itinerary_quote_ID: { contains: s },
            } as any,
            select: { itinerary_plan_ID: true },
            take: 1000,
          },
        );
      const planIdsByConfirmed = confirmedMatches
        .map((x) => Number(x.itinerary_plan_ID))
        .filter((n) => n > 0);

      searchOr = [
        { arrival_location: { contains: s } },
        { departure_location: { contains: s } },
        { itinerary_quote_ID: { contains: s } },
        ...(userIdsBySearch.length
          ? [{ createdby: { in: userIdsBySearch } }]
          : []),
        ...(planIdsByConfirmed.length
          ? [{ itinerary_plan_ID: { in: planIdsByConfirmed } }]
          : []),
      ];
    }

    const where: any = {
      deleted: 0,
      ...(roleOr ? roleOr : {}),
      ...(s ? { OR: searchOr } : {}),
    };

    if (startDate) {
      where.trip_start_date_and_time = {
        ...(where.trip_start_date_and_time ?? {}),
        gte: startDate,
      };
    }
    if (endDate) {
      where.trip_end_date_and_time = {
        ...(where.trip_end_date_and_time ?? {}),
        lte: endDate,
      };
    }

    if (source_location) where.arrival_location = source_location;
    if (destination_location) where.departure_location = destination_location;

    if (filter_agent_id > 0) where.agent_id = filter_agent_id;
    if (filter_staff_id > 0) where.staff_id = filter_staff_id;

    const allPlans = await this.prisma.dvi_itinerary_plan_details.findMany({
      where,
      orderBy: { itinerary_plan_ID: 'desc' },
      select: {
        itinerary_plan_ID: true,
        arrival_location: true,
        departure_location: true,
        trip_start_date_and_time: true,
        trip_end_date_and_time: true,
        expecting_budget: true,
        itinerary_quote_ID: true,
        no_of_routes: true,
        no_of_days: true,
        no_of_nights: true,
        total_adult: true,
        total_children: true,
        total_infants: true,
        itinerary_preference: true,
        preferred_room_count: true,
        total_extra_bed: true,
        status: true,
        deleted: true,
        createdon: true,
        createdby: true,
        staff_id: true,
        agent_id: true,
      } as any,
    });

    const planIds = allPlans
      .map((p: any) => Number(p.itinerary_plan_ID))
      .filter((n) => n > 0);
    const createdByUserIds = allPlans
      .map((p: any) => Number(p.createdby))
      .filter((n) => n > 0);

    const confirmed = planIds.length
      ? await this.prisma.dvi_confirmed_itinerary_plan_details.findMany({
          where: { itinerary_plan_ID: { in: planIds }, deleted: 0 } as any,
          select: { itinerary_plan_ID: true, itinerary_quote_ID: true },
        })
      : [];
    const confirmedMap = new Map<number, string>();
    for (const c of confirmed as any[]) {
      const pid = Number(c.itinerary_plan_ID);
      if (pid) confirmedMap.set(pid, String(c.itinerary_quote_ID ?? ''));
    }

    const users = createdByUserIds.length
      ? await this.prisma.dvi_users.findMany({
          where: { userID: { in: createdByUserIds } } as any,
          select: {
            userID: true,
            roleID: true,
            staff_id: true,
            agent_id: true,
            username: true,
          },
        })
      : [];
    const userMap = new Map<number, any>();
    for (const uu of users as any[]) userMap.set(Number(uu.userID), uu);

    const staffIds = Array.from(
      new Set(
        (users as any[])
          .map((x) => Number(x.staff_id))
          .filter((n) => n > 0),
      ),
    );
    const agentIds = Array.from(
      new Set(
        (users as any[])
          .map((x) => Number(x.agent_id))
          .filter((n) => n > 0),
      ),
    );

    const staffRows = staffIds.length
      ? await this.prisma.dvi_staff_details.findMany({
          where: { staff_id: { in: staffIds } } as any,
          select: { staff_id: true, staff_name: true },
        })
      : [];
    const staffMap = new Map<number, string>();
    for (const st of staffRows as any[])
      staffMap.set(Number(st.staff_id), String(st.staff_name ?? ''));

    const agentRows = agentIds.length
      ? await this.prisma.dvi_agent.findMany({
          where: { agent_ID: { in: agentIds } } as any,
          select: { agent_ID: true, agent_name: true },
        })
      : [];
    const agentMap = new Map<number, string>();
    for (const ag of agentRows as any[])
      agentMap.set(Number(ag.agent_ID), String(ag.agent_name ?? ''));

    let counter = start;

    const unconfirmedPlans = allPlans.filter((p: any) => !confirmedMap.has(Number(p.itinerary_plan_ID)));
    const totalRecords = unconfirmedPlans.length;
    const plans = unconfirmedPlans.slice(start, start + limit);

    const data = (plans ?? []).map((p: any) => {
      counter++;

      const pid = Number(p.itinerary_plan_ID ?? 0) || 0;
      const uRec = userMap.get(Number(p.createdby ?? 0)) ?? null;

      const roleID = Number(uRec?.roleID ?? 0) || 0;
      const staff_id = Number(uRec?.staff_id ?? 0) || 0;
      const agent_id = Number(uRec?.agent_id ?? 0) || 0;

      const staff_name = staff_id ? staffMap.get(staff_id) ?? '' : '';
      const agent_name = agent_id ? agentMap.get(agent_id) ?? '' : '';

      let username = '';
      if (roleID === 1) {
        username = String(uRec?.username ?? '');
      } else if (roleID === 3 && staff_id !== 0 && agent_id === 0) {
        username = `Travel Expert - <br>${staff_name}`;
      } else if (roleID === 4 && staff_id === 0 && agent_id !== 0) {
        username = `Agent - <br>${agent_name}`;
      } else if (roleID === 4 && staff_id !== 0 && agent_id !== 0) {
        username = `Agent - <br>${staff_name}`;
      } else if (roleID === 5 && staff_id !== 0 && agent_id === 0) {
        username = `Guide - <br>${staff_name}`;
      }

      const total_adult = Number(p.total_adult ?? 0) || 0;
      const total_children = Number(p.total_children ?? 0) || 0;
      const total_infants = Number(p.total_infants ?? 0) || 0;

      const total_members = `<span>Adult - ${total_adult}</br>Children - ${total_children}</br>Infants - ${total_infants}</span>`;

      return {
        counter,
        modify: pid,
        itinerary_quote_ID: String(p.itinerary_quote_ID ?? '') || null,
        itinerary_booking_ID: confirmedMap.get(pid) ?? null,
        arrival_location: p.arrival_location ?? '',
        departure_location: p.departure_location ?? '',
        itinerary_preference:
          Number(p.itinerary_preference ?? 0) || 0,
        no_of_days_and_nights: `${
          Number(p.no_of_nights ?? 0) || 0
        }&${Number(p.no_of_days ?? 0) || 0}`,
        no_of_person: total_members,
        trip_start_date_and_time: this.formatTripDateTime(
          p.trip_start_date_and_time,
        ),
        trip_end_date_and_time: this.formatTripDateTime(
          p.trip_end_date_and_time,
        ),
        total_adult,
        total_children,
        total_infants,
        username,
        createdon: this.formatCreatedOn(p.createdon),
      };
    });

    return {
      draw,
      recordsTotal: totalRecords,
      recordsFiltered: totalRecords,
      data,
    };
  }
}

