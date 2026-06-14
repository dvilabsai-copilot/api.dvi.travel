import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma.service";
import { clearCityLookupCache } from "../../itineraries/utils/city-normalization.util";
import { CreateCityDto } from "./dto/create-city.dto";
import { UpdateCityDto } from "./dto/update-city.dto";
import { SuggestCitiesDto } from "./dto/suggest-cities.dto";
import { CheckCityDuplicateDto } from "./dto/check-city.dto";

@Injectable()
export class CitiesService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveCountryId(requested?: number) {
    if (requested && Number.isFinite(requested)) {
      // if requested actually has states, keep it
      const cnt = await this.prisma.dvi_states.count({
        where: { country_id: requested, deleted: 0 },
      });
      if (cnt > 0) return requested;
    }

    // Try lookup by country name "India" (safe across DBs)
    const india = await this.prisma.dvi_countries.findFirst({
      where: { deleted: 0, name: { equals: "India" } },
      select: { id: true },
    });

    return india?.id ?? 1; // schema default
  }

  // Mirrors __JSONcities.php behavior but without hardcoded India id.
  async list(countryId = 101) {
  const cid = await this.resolveCountryId(countryId);

  const rows = await this.prisma.$queryRaw<
    Array<{
      city_id: number;
      city_name: string;
      state_id: number;
      state_name: string | null;
      country_id: number | null;
      status: number;
      deleted: number;
    }>
  >`
    SELECT
      c.id      AS city_id,
      c.name    AS city_name,
      c.state_id AS state_id,
      s.name    AS state_name,
      s.country_id AS country_id,
      c.status  AS status,
      c.deleted AS deleted
    FROM dvi_cities c
    LEFT JOIN dvi_states s ON c.state_id = s.id
    WHERE s.country_id = ${cid}
      AND c.deleted = 0
    ORDER BY c.id DESC
  `;

  return {
    data: rows.map((r) => ({
      id: r.city_id,
      city_id: r.city_id,
      city_name: r.city_name,
      name: r.city_name,
      state_id: r.state_id,
      state_name: r.state_name ?? "",
      country_id: r.country_id ?? cid,
      status: r.status,
      deleted: r.deleted,
    })),
  };
}

  async getOne(id: number) {
    const row = await this.prisma.dvi_cities.findUnique({
      where: { id },
      select: { id: true, name: true, state_id: true, status: true, deleted: true },
    });
    if (!row || row.deleted === 1) throw new NotFoundException("City not found");

    const st = await this.prisma.dvi_states.findUnique({
      where: { id: row.state_id },
      select: { id: true, name: true, country_id: true, deleted: true },
    });

    return {
      data: {
        id: row.id,
        city_id: row.id,
        city_name: row.name,
        name: row.name,
        state_id: row.state_id,
        state_name: st && st.deleted === 0 ? st.name : "",
        country_id: st?.country_id ?? 0,
        status: row.status,
        deleted: row.deleted,
      },
    };
  }

  async create(dto: CreateCityDto) {
    if (!dto.city_name?.trim()) throw new BadRequestException("city_name required");
    if (!dto.state_id) throw new BadRequestException("state_id required");

    const created = await this.prisma.dvi_cities.create({
      data: {
        state_id: dto.state_id,
        name: dto.city_name.trim(),
        status: typeof (dto as any).status === "number" ? (dto as any).status : 1,
        deleted: 0,
      },
      select: { id: true },
    });

    clearCityLookupCache();

    return this.getOne(created.id);
  }

  async update(id: number, dto: UpdateCityDto) {
    const existing = await this.prisma.dvi_cities.findUnique({
      where: { id },
      select: { id: true, deleted: true },
    });
    if (!existing || existing.deleted === 1) throw new NotFoundException("City not found");

    const data: any = {};
    if (typeof dto.state_id === "number") data.state_id = dto.state_id;
    if (typeof dto.city_name === "string") data.name = dto.city_name.trim();
    if (typeof (dto as any).status === "number") data.status = (dto as any).status;

    await this.prisma.dvi_cities.update({ where: { id }, data });

    clearCityLookupCache();

    return this.getOne(id);
  }

  async softDelete(id: number) {
    const existing = await this.prisma.dvi_cities.findUnique({
      where: { id },
      select: { id: true, deleted: true },
    });
    if (!existing || existing.deleted === 1) throw new NotFoundException("City not found");

    await this.prisma.dvi_cities.update({
      where: { id },
      data: { deleted: 1, updatedon: new Date() },
    });

    clearCityLookupCache();

    return { result: true };
  }

  async suggest(dto: SuggestCitiesDto) {
    const term = (dto.term ?? "").trim();
    if (term.length < 2) return [];

    const rows = await this.prisma.dvi_cities.findMany({
      where: {
        deleted: 0,
        state_id: dto.state_id,
        name: { contains: term },
      },
      orderBy: { id: "desc" },
      take: 25,
      select: { id: true, name: true },
    });

    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  async checkDuplicate(dto: CheckCityDuplicateDto) {
    const cityName = (dto.city_name ?? "").trim();
    const old = (dto.old_city_name ?? "").trim();

    if (!cityName) return { exists: false };
    if (old && cityName.toLowerCase() === old.toLowerCase()) return { exists: false };

    const found = await this.prisma.dvi_cities.findFirst({
      where: {
        deleted: 0,
        state_id: dto.state_id,
        name: cityName,
      },
      select: { id: true },
    });

    return { exists: !!found };
  }

  // Mirrors PHP delete modal “used count” check (BUG replicated: hotel_category = cityId)
  async getDeleteUsageCount(cityId: number) {
    const count = await this.prisma.dvi_hotel.count({
      where: {
        status: 1,
        hotel_category: cityId, // intentionally matching PHP
        // IMPORTANT: your legacy schema usually stores deleted as 0/1, not boolean
        deleted: 0 as any,
      },
    });

    return { totalUsedCount: count, canDelete: count === 0 };
  }

  // Helpful for dropdowns (replaces getSTATELIST(India))
  async listStates(countryId = 101) {
    const cid = await this.resolveCountryId(countryId);

    const rows = await this.prisma.dvi_states.findMany({
      where: { country_id: cid, deleted: 0 },
      orderBy: { name: "asc" },
      select: { id: true, name: true, country_id: true },
    });

    return {
      data: rows.map((s) => ({
        state_id: s.id,
        state_name: s.name,
        country_id: s.country_id,
      })),
    };
  }
  // add inside CitiesService class
async getCitiesByIds(cityIds: number[]) {
  const cities = await this.prisma.dvi_cities.findMany({
    where: { id: { in: cityIds }, deleted: 0 },
    select: { id: true, name: true, state_id: true, status: true },
  });

  const stateIds = [...new Set(cities.map((c) => c.state_id))];
  const states = await this.prisma.dvi_states.findMany({
    where: { id: { in: stateIds } },
    select: { id: true, name: true },
  });

  const stateMap = new Map(states.map((s) => [s.id, s.name]));

  return {
    data: cities.map((c) => ({
      city_id: c.id,
      city_name: c.name,
      state_id: c.state_id,
      state_name: stateMap.get(c.state_id) ?? "",
      status: c.status,
    })),
  };
}
async debug(countryId = 101) {
  const cid = await this.resolveCountryId(countryId);

  const statesCount = await this.prisma.dvi_states.count({
    where: { country_id: cid, deleted: 0 },
  });

  const citiesTotal = await this.prisma.dvi_cities.count();
  const citiesDeleted0 = await this.prisma.dvi_cities.count({ where: { deleted: 0 } });

  const joinCount = await this.prisma.$queryRaw<any[]>`
    SELECT COUNT(*) AS join_count
    FROM dvi_cities c
    JOIN dvi_states s ON s.id = c.state_id
    WHERE s.country_id = ${cid}
      AND c.deleted = 0
  `;

  return {
    countryIdResolved: cid,
    statesCount,
    citiesTotal,
    citiesDeleted0,
    joinCount: Number(joinCount?.[0]?.join_count ?? 0),
  };
}
  // ✅ NEW: list cities by state_id
  async listByState(stateId: number) {
  const st = await this.prisma.dvi_states.findUnique({
    where: { id: stateId },
    select: { id: true, name: true, deleted: true, country_id: true },
  });

  if (!st || st.deleted === 1) {
    return { data: [] };
  }

  const cities = await this.prisma.dvi_cities.findMany({
    where: { deleted: 0, state_id: stateId },
    orderBy: { id: "desc" }, // PHP style (latest first)
    select: { id: true, name: true, state_id: true, status: true, deleted: true },
  });

  return {
    data: cities.map((c) => ({
      id: c.id,
      city_id: c.id,
      city_name: c.name,
      name: c.name,
      state_id: c.state_id,
      state_name: st.name,
      status: c.status,
      deleted: c.deleted,
      country_id: st.country_id,
    })),
  };
}
  // ✅ NEW: list cities by countryId with pagination and search
  async listByCountry(
  countryId = 101,
  q?: { page?: number; pageSize?: number; search?: string }
) {
  const cid = await this.resolveCountryId(countryId);

  const page = Math.max(1, Number(q?.page ?? 1));
  const pageSize = Math.min(2000, Math.max(1, Number(q?.pageSize ?? 500)));
  const search = (q?.search ?? "").trim();

  // 1) Fetch states for the country (this is your "JOIN base")
  const states = await this.prisma.dvi_states.findMany({
    where: { country_id: cid, deleted: 0 },
    select: { id: true, name: true },
  });

  const stateIds = states.map((s) => s.id);
  if (stateIds.length === 0) {
    return { data: [], meta: { page, pageSize, total: 0 } };
  }

  const stateMap = new Map(states.map((s) => [s.id, s.name]));

  // If user searches by STATE name, we must include cities under those matched states too
  const matchedStateIdsByName =
    search.length > 0
      ? states
          .filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
          .map((s) => s.id)
      : [];

  // 2) Build Prisma where for cities
  const where: Prisma.dvi_citiesWhereInput = {
    deleted: 0,
    state_id: { in: stateIds },
    ...(search
      ? {
          OR: [
            // search city name
            { name: { contains: search } },
            // search state name (translated to state_id IN matched list)
            ...(matchedStateIdsByName.length
              ? [{ state_id: { in: matchedStateIdsByName } }]
              : []),
          ],
        }
      : {}),
  };

  // total count
  const total = await this.prisma.dvi_cities.count({ where });

  // paginated rows
  const rows = await this.prisma.dvi_cities.findMany({
    where,
    orderBy: { id: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: { id: true, name: true, state_id: true, status: true },
  });

  return {
    data: rows.map((c) => ({
      city_id: c.id,
      city_name: c.name,
      state_id: c.state_id,
      state: {
        state_id: c.state_id,
        state_name: stateMap.get(c.state_id) ?? "",
      },
      status: (c.status === 1 ? 1 : 0) as 0 | 1,
    })),
    meta: { page, pageSize, total },
  };
}
}
