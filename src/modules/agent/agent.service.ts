// FILE: src/modules/agent/agent.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { ListAgentQueryDto } from './dto/list-agent.dto';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { AgentPreviewDto } from './dto/agent-preview.dto';
import { mapAgentToListRow } from './agent.mapper';

type SubRow = {
  id: number;
  subscription_title: string;
  amount: string;
  validity_start: string;
  validity_end: string;
  transaction_id: string;
  payment_status: string;
};

@Injectable()
export class AgentService {
  constructor(private readonly prisma: PrismaService) {}

   private buildAgentCompanyLocationDisplayName(agent: any, cityName?: string | null): string {
    const companyName = String(agent?.company_name || '')
      .replace(/\s+/g, ' ')
      .trim();

    const fallbackName = String(agent?.agent_name || '')
      .replace(/\s+/g, ' ')
      .trim();

    const location = String(cityName || '')
      .replace(/\s+/g, ' ')
      .trim();

    const baseName = companyName || fallbackName || 'Agent';

    return location ? `${baseName} - ${location}` : baseName;
  }

  private async getAgentCompanyNameMap(agentIds: number[]) {
    if (!agentIds.length) return new Map<number, string>();

    const placeholders = agentIds.map(() => '?').join(',');

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ agent_id: number; company_name: string | null }>
    >(
      `
        SELECT agent_id, company_name
        FROM dvi_agent_configuration
        WHERE deleted = 0
          AND status = 1
          AND agent_id IN (${placeholders})
      `,
      ...agentIds,
    );

    const map = new Map<number, string>();

    for (const row of rows) {
      const companyName = String(row.company_name || '')
        .replace(/\s+/g, ' ')
        .trim();

      if (companyName && !map.has(Number(row.agent_id))) {
        map.set(Number(row.agent_id), companyName);
      }
    }

    return map;
  }

  /** ---------- Helpers: user & geo label maps ---------- */
   private async getUsersMapByAgentIds(agentIds: number[]) {
    if (agentIds.length === 0) return new Map<number, any>();
    const users = await this.prisma.dvi_users.findMany({
      where: { deleted: 0, agent_id: { in: agentIds } },
      orderBy: { userID: 'desc' },
    });
    const map = new Map<number, any>();
    for (const u of users) {
      const k = u.agent_id;
      if (k == null) continue;
      if (!map.has(k)) map.set(k, u);
    }
    return map;
  }

  private async getCompanyNameMapByAgentIds(agentIds: number[]) {
    if (agentIds.length === 0) return new Map<number, string>();

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ agent_id: number; company_name: string | null }>
    >(
      `
        SELECT agent_id, company_name
        FROM dvi_agent_configuration
        WHERE deleted = 0
          AND agent_id IN (${agentIds.map(() => '?').join(',')})
        ORDER BY agent_config_id DESC
      `,
      ...agentIds,
    );

    const map = new Map<number, string>();

    for (const row of rows) {
      const agentId = Number(row.agent_id || 0);
      const companyName = String(row.company_name || '')
        .replace(/\s+/g, ' ')
        .trim();

      if (agentId > 0 && companyName && !map.has(agentId)) {
        map.set(agentId, companyName);
      }
    }

    return map;
  }

  private async getGeoNameMaps(opts: {
    countryIds: number[];
    stateIds: number[];
    cityIds: number[];
  }) {
    const unique = <T extends number>(arr: T[]) =>
      Array.from(new Set(arr.filter((x): x is T => typeof x === 'number')));

    const [countries, states, cities] = await this.prisma.$transaction([
      this.prisma.dvi_countries.findMany({
        where: { id: { in: unique(opts.countryIds) } },
        select: { id: true, name: true },
      }),
      this.prisma.dvi_states.findMany({
        where: { id: { in: unique(opts.stateIds) } },
        select: { id: true, name: true },
      }),
      this.prisma.dvi_cities.findMany({
        where: { id: { in: unique(opts.cityIds) } },
        select: { id: true, name: true },
      }),
    ]);

    const countryMap = new Map<number, string>();
    for (const c of countries) countryMap.set(c.id, c.name ?? '');

    const stateMap = new Map<number, string>();
    for (const s of states) stateMap.set(s.id, s.name ?? '');

    const cityMap = new Map<number, string>();
    for (const c of cities) cityMap.set(c.id, c.name ?? '');

    return { countryMap, stateMap, cityMap };
  }

  /** Latest subscription title for a single agent (used in preview) */
  private async getLatestSubscriptionTitle(agentId: number): Promise<string | null> {
    const row = await this.prisma.dvi_agent_subscribed_plans.findFirst({
      where: { agent_ID: agentId, deleted: 0 },
      orderBy: [{ createdon: 'desc' }, { agent_subscribed_plan_ID: 'desc' }],
      select: { subscription_plan_title: true },
    });
    const title = row?.subscription_plan_title?.toString().trim();
    return title && title.length > 0 ? title : null;
  }

  /** Batch: latest subscription title per agent (fast) */
  private async getLatestSubscriptionTitleMap(agentIds: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (!agentIds.length) return out;

    // Newest-first per agent; first seen wins
    const rows = await this.prisma.dvi_agent_subscribed_plans.findMany({
      where: { deleted: 0, agent_ID: { in: agentIds } },
      orderBy: [{ agent_ID: 'asc' }, { createdon: 'desc' }, { agent_subscribed_plan_ID: 'desc' }],
      select: { agent_ID: true, subscription_plan_title: true },
    });

    for (const r of rows) {
      const aId = r.agent_ID;
      if (!out.has(aId)) {
        const t = r.subscription_plan_title?.toString().trim();
        if (t) out.set(aId, t);
      }
    }
    return out;
  }

  /** ---------- LIST (legacy -> keeps your old table mapper) ---------- */
  async list(query: ListAgentQueryDto) {
    const isDT = typeof query.start === 'number' && typeof query.length === 'number';
    const take = isDT ? query.length! : query.limit!;
    const skip = isDT ? query.start! : query.page! * query.limit!;
    const q = (query.q ?? '').trim();

    const where: any = {
      deleted: 0,
      ...(query.travelExpertId ? { travel_expert_id: query.travelExpertId } : {}),
      ...(q
        ? {
            OR: [
              { agent_name: { contains: q } },
              { agent_lastname: { contains: q } },
              { agent_email_id: { contains: q } },
              { agent_primary_mobile_number: { contains: q } },
            ],
          }
        : {}),
    };

    const [rows, total, filtered] = await this.prisma.$transaction([
      this.prisma.dvi_agent.findMany({
        where,
        skip,
        take,
        orderBy: { agent_ID: 'desc' },
      }),
      this.prisma.dvi_agent.count({ where: { deleted: 0 } }),
      this.prisma.dvi_agent.count({ where }),
    ]);

       const agentIds = rows.map((r) => r.agent_ID);

    const [usersMap, companyNameMap] = await Promise.all([
      this.getUsersMapByAgentIds(agentIds),
      this.getCompanyNameMapByAgentIds(agentIds),
    ]);

    const countryIds = rows.map((r) => r.agent_country ?? 0).filter(Boolean) as number[];
    const stateIds = rows.map((r) => r.agent_state ?? 0).filter(Boolean) as number[];
    const cityIds = rows.map((r) => r.agent_city ?? 0).filter(Boolean) as number[];

    const { countryMap, stateMap, cityMap } = await this.getGeoNameMaps({
      countryIds,
      stateIds,
      cityIds,
    });

      // legacy list uses your mapper, but agent dropdown/table name should show name with city
    const data = rows.map((a, idx) => {
           const cityLabel = a.agent_city ? cityMap.get(a.agent_city) ?? null : null;
      const companyName = companyNameMap.get(a.agent_ID) ?? null;
      const displayName = this.buildAgentCompanyLocationDisplayName(
        {
          ...a,
          company_name: companyName,
        },
        cityLabel,
      );

      const mapped = mapAgentToListRow(
        {
          ...a,
          agent_name: displayName,
          agent_lastname: null,
          user: usersMap.get(a.agent_ID) ?? null,
          country_label: a.agent_country ? countryMap.get(a.agent_country) ?? null : null,
          state_label: a.agent_state ? stateMap.get(a.agent_state) ?? null : null,
          city_label: cityLabel,
        },
        skip + idx,
      );

      return {
        ...mapped,
        id: a.agent_ID,
        name: displayName,
        agent_name: displayName,
        agent_lastname: null,
        city_label: cityLabel,
      };
    });

    if (isDT) {
      return {
        draw: query.draw ?? '1',
        recordsTotal: total,
        recordsFiltered: filtered,
        data,
      };
    }

    return {
      total,
      filtered,
      page: isDT ? Math.floor(skip / take) : query.page,
      limit: take,
      data,
    };
  }

  /** ---------- LIST FULL (detailed preview-style rows for every agent) ---------- */
  async listFull(query: ListAgentQueryDto) {
    const isDT = typeof query.start === 'number' && typeof query.length === 'number';
    const take = isDT ? query.length! : query.limit!;
    const skip = isDT ? query.start! : query.page! * query.limit!;
    const q = (query.q ?? '').trim();

    const where: any = {
      deleted: 0,
      ...(q
        ? {
            OR: [
              { agent_name: { contains: q } },
              { agent_lastname: { contains: q } },
              { agent_email_id: { contains: q } },
              { agent_primary_mobile_number: { contains: q } },
            ],
          }
        : {}),
    };

    const [rows, total, filtered] = await this.prisma.$transaction([
      this.prisma.dvi_agent.findMany({
        where,
        skip,
        take,
        orderBy: { agent_ID: 'desc' },
      }),
      this.prisma.dvi_agent.count({ where: { deleted: 0 } }),
      this.prisma.dvi_agent.count({ where }),
    ]);

    const agentIds = rows.map((r) => r.agent_ID);

    // Batch helpers
      const [usersMap, geoMaps, subsMap, companyNameMap] = await Promise.all([
      this.getUsersMapByAgentIds(agentIds),
      this.getGeoNameMaps({
        countryIds: rows.map((r) => r.agent_country ?? 0).filter(Boolean) as number[],
        stateIds: rows.map((r) => r.agent_state ?? 0).filter(Boolean) as number[],
        cityIds: rows.map((r) => r.agent_city ?? 0).filter(Boolean) as number[],
      }),
      this.getLatestSubscriptionTitleMap(agentIds),
      this.getCompanyNameMapByAgentIds(agentIds),
    ]);

    const { countryMap, stateMap, cityMap } = geoMaps;

    // Build the EXACT object you requested per agent
    const data = rows.map((a) => {
      const user = usersMap.get(a.agent_ID) ?? null;
      const login_enabled = !!(user && user.userapproved === 1 && user.userbanned === 0);

              const cityLabel = a.agent_city ? cityMap.get(a.agent_city) ?? null : null;
      const companyName = companyNameMap.get(a.agent_ID) ?? null;
      const displayName = this.buildAgentCompanyLocationDisplayName(
        {
          ...a,
          company_name: companyName,
        },
        cityLabel,
      );

      const obj: AgentPreviewDto = {
        agent_ID: a.agent_ID,
        agent_name: displayName,
        agent_lastname: null,
        agent_email_id: a.agent_email_id ?? null,
        agent_primary_mobile_number: a.agent_primary_mobile_number ?? null,
        agent_alternative_mobile_number: a.agent_alternative_mobile_number ?? null,
        agent_country: a.agent_country ?? null,
        agent_state: a.agent_state ?? null,
        agent_city: a.agent_city ?? null,
        agent_gst_number: a.agent_gst_number ?? null,
        agent_gst_attachment: a.agent_gst_attachment ?? null,
        subscription_plan_id: a.subscription_plan_id ?? null,
        travel_expert_id: a.travel_expert_id ?? null,
        login_enabled,

        country_label: a.agent_country ? countryMap.get(a.agent_country) ?? null : null,
        state_label: a.agent_state ? stateMap.get(a.agent_state) ?? null : null,
        city_label: cityLabel,

        // Latest title, fallback "Free" to mirror your single-agent preview
        subscription_title: subsMap.get(a.agent_ID) ?? 'Free',
        // Until you wire experts table, keep null (matches your preview response)
        travel_expert_label: null,
      };

      return obj;
    });

    if (isDT) {
      return {
        draw: query.draw ?? '1',
        recordsTotal: total,
        recordsFiltered: filtered,
        data,
      };
    }

    return {
      total,
      filtered,
      page: isDT ? Math.floor(skip / take) : query.page,
      limit: take,
      data,
    };
  }

  /** ---------- PREVIEW / EDIT PREFILL (single) ---------- */
  async getById(id: number): Promise<AgentPreviewDto> {
    const a = await this.prisma.dvi_agent.findFirst({
      where: { agent_ID: id, deleted: 0 },
    });
    if (!a) throw new NotFoundException('Agent not found');

    const user = await this.prisma.dvi_users.findFirst({
      where: { deleted: 0, agent_id: id },
      orderBy: { userID: 'desc' },
    });
    const login_enabled = !!(user && user.userapproved === 1 && user.userbanned === 0);

    const { countryMap, stateMap, cityMap } = await this.getGeoNameMaps({
      countryIds: a.agent_country ? [a.agent_country] : [],
      stateIds: a.agent_state ? [a.agent_state] : [],
      cityIds: a.agent_city ? [a.agent_city] : [],
    });

    const latestTitle = await this.getLatestSubscriptionTitle(a.agent_ID);

    const dto: AgentPreviewDto = {
      agent_ID: a.agent_ID,
      agent_name: a.agent_name ?? null,
      agent_lastname: a.agent_lastname ?? null,
      agent_email_id: a.agent_email_id ?? null,
      agent_primary_mobile_number: a.agent_primary_mobile_number ?? null,
      agent_alternative_mobile_number: a.agent_alternative_mobile_number ?? null,
      agent_country: a.agent_country ?? null,
      agent_state: a.agent_state ?? null,
      agent_city: a.agent_city ?? null,
      agent_gst_number: a.agent_gst_number ?? null,
      agent_gst_attachment: a.agent_gst_attachment ?? null,
      subscription_plan_id: a.subscription_plan_id ?? null,
      travel_expert_id: a.travel_expert_id ?? null,
      login_enabled,

      country_label: a.agent_country ? countryMap.get(a.agent_country) ?? null : null,
      state_label: a.agent_state ? stateMap.get(a.agent_state) ?? null : null,
      city_label: a.agent_city ? cityMap.get(a.agent_city) ?? null : null,

      subscription_title: latestTitle ?? 'Free',
      travel_expert_label: null,
    };

    return dto;
  }

  async getEditPrefill(id: number) {
    return this.getById(id);
  }

  /** ---------- Subscriptions table for preview ---------- */
  async getSubscriptions(agentId: number) {
    const agent = await this.prisma.dvi_agent.findFirst({
      where: { agent_ID: agentId, deleted: 0 },
      select: { agent_ID: true },
    });
    if (!agent) throw new NotFoundException('Agent not found');

    const rows = await this.prisma.dvi_agent_subscribed_plans.findMany({
      where: { agent_ID: agentId, deleted: 0 },
      orderBy: [{ createdon: 'desc' }, { agent_subscribed_plan_ID: 'desc' }],
      select: {
        agent_subscribed_plan_ID: true,
        subscription_plan_title: true,
        subscription_amount: true,
        validity_start: true,
        validity_end: true,
        transaction_id: true,
        subscription_payment_status: true,
      },
    });

    const fmt = (d?: Date | null) =>
      d
        ? new Date(d).toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          })
        : '';

    const paymentLabel = (n?: number | null) => {
      if (n === 1) return 'Paid';
      if (n === 2) return 'Pending';
      if (n === 3) return 'Failed';
      return 'Free';
    };

    const data: SubRow[] = rows.map((r, i) => ({
      id: i + 1,
      subscription_title: (r.subscription_plan_title ?? 'Free').toString(),
      amount:
        typeof r.subscription_amount === 'number'
          ? `₹${r.subscription_amount.toFixed(2)}`
          : '₹0.00',
      validity_start: fmt(r.validity_start),
      validity_end: fmt(r.validity_end),
      transaction_id: r.transaction_id ?? '--',
      payment_status: paymentLabel(r.subscription_payment_status),
    }));

    return {
      data,
      total: data.length,
      page: 0,
      limit: data.length,
    };
  }

  /** ---------- LIGHTWEIGHT NAMES LIST ---------- */
  async listNames() {
    const agents = await this.prisma.dvi_agent.findMany({
      where: { deleted: 0, status: 1 },
      select: {
        agent_ID: true,
        agent_name: true,
        agent_lastname: true,
        agent_city: true,
      },
      orderBy: { agent_ID: 'desc' },
    });

    const { cityMap } = await this.getGeoNameMaps({
      countryIds: [],
      stateIds: [],
      cityIds: agents.map((a) => a.agent_city ?? 0).filter(Boolean) as number[],
    });

     const companyNameMap = await this.getCompanyNameMapByAgentIds(
      agents.map((a) => a.agent_ID),
    );

    return agents.map((a) => {
      const cityLabel = a.agent_city ? cityMap.get(a.agent_city) ?? null : null;
      const companyName = companyNameMap.get(a.agent_ID) ?? null;

      return {
        id: a.agent_ID,
        name: this.buildAgentCompanyLocationDisplayName(
          {
            ...a,
            company_name: companyName,
          },
          cityLabel,
        ),
      };
    });
  }

  /** ---------- MUTATIONS ---------- */
  async create(payload: CreateAgentDto) {
    const created = await this.prisma.dvi_agent.create({
      data: {
        ...payload,
        deleted: 0,
        status: 1,
        createdon: new Date(),
        updatedon: new Date(),
      },
    });
    return { agent_ID: created.agent_ID };
  }

  async update(id: number, payload: UpdateAgentDto) {
    const exists = await this.prisma.dvi_agent.findFirst({
      where: { agent_ID: id, deleted: 0 },
      select: { agent_ID: true },
    });
    if (!exists) throw new NotFoundException('Agent not found');

    await this.prisma.dvi_agent.update({
      where: { agent_ID: id },
      data: {
        ...payload,
        updatedon: new Date(),
      },
    });
    return { agent_ID: id, updated: true };
  }

  async softDelete(id: number) {
    const exists = await this.prisma.dvi_agent.findFirst({
      where: { agent_ID: id, deleted: 0 },
      select: { agent_ID: true },
    });
    if (!exists) throw new NotFoundException('Agent not found');

    await this.prisma.dvi_agent.update({
      where: { agent_ID: id },
      data: { deleted: 1, updatedon: new Date() },
    });
    return { agent_ID: id, deleted: true };
  }
}
