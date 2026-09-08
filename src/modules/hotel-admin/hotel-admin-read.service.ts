import {
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { SystemRole } from '../auth/constants/system-role.constants';
import { HotelAdminService } from './hotel-admin.service';
import { HotelAdminPermissionKey } from './hotel-admin-permissions';

type HotelRow = {
  hotel_id: number | bigint;
  hotel_name: string | null;
  hotel_code: string | null;
  hotel_email: string | null;
  hotel_mobile: string | null;
  hotel_city: string | null;
  hotel_state: string | null;
  hotel_address: string | null;
  hotel_city_name: string | null;
  hotel_state_name: string | null;
  axisrooms_property_id: string | null;
  status: number | boolean | null;
};

type HotelAdminRoomIndexRow = {
  room_ID: bigint | number;
  hotel_id: bigint | number;
  hotel_name: string | null;
  room_title: string | null;
  room_type_id:
    | bigint
    | number
    | null;
  no_of_rooms_available:
    | bigint
    | number
    | null;
  total_max_adults:
    | bigint
    | number
    | null;
  total_max_childrens:
    | bigint
    | number
    | null;
  air_conditioner_availability:
    | number
    | boolean
    | null;
  check_in_time: unknown;
  check_out_time: unknown;
  status:
    | number
    | boolean
    | null;
};
@Injectable()
export class HotelAdminReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelAdminService: HotelAdminService,
  ) {}

  private parseUserId(value: unknown): bigint {
    try {
      const userId = BigInt(String(value ?? '0'));

      if (userId <= 0n) {
        throw new Error();
      }

      return userId;
    } catch {
      throw new ForbiddenException(
        'Invalid authenticated Hotel Admin user',
      );
    }
  }

  private async requireHotelAdminUser(
    userIdValue: unknown,
  ) {
    const userId = this.parseUserId(userIdValue);

    const user =
      await this.prisma.dvi_users.findFirst({
        where: {
          userID: userId,
          roleID: SystemRole.HOTEL_ADMIN,
          status: 1,
          deleted: 0,
        },
        select: {
          userID: true,
          username: true,
          useremail: true,
          roleID: true,
        },
      });

    if (!user) {
      throw new ForbiddenException(
        'Active Hotel Admin account required',
      );
    }

    return user;
  }

  private normalizePage(value: unknown): number {
    const parsed = Number(value);

    return Number.isInteger(parsed) && parsed > 0
      ? parsed
      : 1;
  }

  private normalizeLimit(value: unknown): number {
    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0) {
      return 25;
    }

    return Math.min(parsed, 100);
  }

  async getContext(
    userIdValue: unknown,
  ) {
    const user =
      await this.requireHotelAdminUser(
        userIdValue,
      );

    const countRows =
      await this.prisma.$queryRaw<
        Array<{ assigned_count: bigint | number }>
      >`
        SELECT COUNT(*) AS assigned_count
        FROM dvi_hotel_admin_user_hotel AS assignment
        INNER JOIN dvi_hotel AS hotel
          ON hotel.hotel_id = assignment.hotel_id
        WHERE assignment.user_id = ${user.userID}
          AND assignment.status = 1
          AND assignment.deleted = 0
          AND hotel.deleted = 0
      `;

    const defaultHotels =
      await this.prisma.$queryRaw<
        HotelRow[]
      >`
        SELECT
          hotel.hotel_id,
          hotel.hotel_name,
          hotel.hotel_code,
          hotel.hotel_email,
          hotel.hotel_mobile,
          hotel.hotel_city,
          hotel.hotel_state,
          hotel.hotel_address,
          hotel.status
        FROM dvi_hotel_admin_user_hotel AS assignment
        INNER JOIN dvi_hotel AS hotel
          ON hotel.hotel_id = assignment.hotel_id
        WHERE assignment.user_id = ${user.userID}
          AND assignment.status = 1
          AND assignment.deleted = 0
          AND hotel.deleted = 0
        ORDER BY hotel.hotel_name ASC, hotel.hotel_id ASC
        LIMIT 1
      `;

    const permissionRows =
      await this.prisma
        .dvi_hotel_admin_user_permission
        .findMany({
          where: {
            user_id: user.userID,
            status: 1,
            deleted: 0,
          },
          orderBy: {
            permission_key: 'asc',
          },
        });

    const defaultHotel =
      defaultHotels[0]
        ? {
            hotel_id:
              Number(defaultHotels[0].hotel_id),
            hotel_name:
              defaultHotels[0].hotel_name,
            hotel_code:
              defaultHotels[0].hotel_code,
            hotel_email:
              defaultHotels[0].hotel_email,
            hotel_mobile:
              defaultHotels[0].hotel_mobile,
            hotel_city:
              defaultHotels[0].hotel_city,
            hotel_state:
              defaultHotels[0].hotel_state,
            hotel_address:
              defaultHotels[0].hotel_address,
            status:
              defaultHotels[0].status,
          }
        : null;

    return {
      user: {
        id: user.userID.toString(),
        email: user.useremail ?? '',
        fullName: user.username ?? '',
        roleID: Number(user.roleID),
      },

      assignedHotelCount:
        Number(
          countRows[0]?.assigned_count ?? 0,
        ),

      defaultHotel,

      permissions:
        permissionRows.map((row) => ({
          key: row.permission_key,
          view: row.can_view === 1,
          create: row.can_create === 1,
          edit: row.can_edit === 1,
          delete: row.can_delete === 1,
        })),
    };
  }

  async listHotels(
    userIdValue: unknown,
    options: {
      page?: unknown;
      limit?: unknown;
      search?: unknown;
      hotel_state?: unknown;
      hotel_city?: unknown;
      provider?: unknown;
    },
  ) {
    const user =
      await this.hotelAdminService.assertPermission(
        userIdValue,
        HotelAdminPermissionKey.HOTELS,
        'view',
      );

    const page =
      this.normalizePage(options.page);

    const limit =
      this.normalizeLimit(options.limit);

    const offset =
      (page - 1) * limit;

    const search =
      String(options.search ?? '')
        .trim()
        .slice(0, 100);

    const hotelState =
      String(options.hotel_state ?? '')
        .trim();

    const hotelCity =
      String(options.hotel_city ?? '')
        .trim();

    const provider =
      String(options.provider ?? '')
        .trim()
        .toLowerCase();

    let fromSql = `
      FROM dvi_hotel_admin_user_hotel AS assignment
      INNER JOIN dvi_hotel AS hotel
        ON hotel.hotel_id = assignment.hotel_id
      LEFT JOIN dvi_states AS hotel_state_meta
        ON hotel_state_meta.id = CAST(hotel.hotel_state AS UNSIGNED)
        AND hotel_state_meta.deleted = 0
      LEFT JOIN dvi_cities AS hotel_city_meta
        ON hotel_city_meta.id = CAST(hotel.hotel_city AS UNSIGNED)
        AND hotel_city_meta.deleted = 0
      WHERE assignment.user_id = ?
        AND assignment.status = 1
        AND assignment.deleted = 0
        AND hotel.deleted = 0
    `;

    const params: any[] = [
      user.userID,
    ];

    if (hotelState) {
      fromSql += `
        AND hotel.hotel_state = ?
      `;
      params.push(hotelState);
    }

    if (hotelCity) {
      fromSql += `
        AND hotel.hotel_city = ?
      `;
      params.push(hotelCity);
    }

    if (provider === 'axisrooms') {
      fromSql += `
        AND hotel.axisrooms_enabled = 1
        AND hotel.axisrooms_property_id IS NOT NULL
        AND hotel.axisrooms_property_id <> ''
      `;
    } else if (provider === 'resavenue') {
      fromSql += `
        AND hotel.resavenue_hotel_code IS NOT NULL
        AND hotel.resavenue_hotel_code <> ''
      `;
    } else if (provider === 'staah') {
      fromSql += `
        AND hotel.staah_enabled = 1
        AND hotel.staah_property_id IS NOT NULL
        AND hotel.staah_property_id <> ''
      `;
    }

    if (search) {
      fromSql += `
        AND (
          hotel.hotel_name LIKE ?
          OR hotel.hotel_code LIKE ?
          OR hotel.hotel_mobile LIKE ?
          OR hotel.hotel_email LIKE ?
          OR hotel.hotel_address LIKE ?
          OR hotel.hotel_place LIKE ?
          OR hotel.hotel_city LIKE ?
          OR hotel.hotel_state LIKE ?
          OR hotel_city_meta.name LIKE ?
          OR hotel_state_meta.name LIKE ?
        )
      `;

      const pattern = `%${search}%`;

      params.push(
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
      );
    }

    const countSql = `
      SELECT COUNT(*) AS total
      ${fromSql}
    `;

    const dataSql = `
      SELECT
        hotel.hotel_id,
        hotel.hotel_name,
        hotel.hotel_code,
        hotel.hotel_email,
        hotel.hotel_mobile,
        hotel.hotel_city,
        hotel.hotel_state,
        hotel.hotel_address,
        hotel.axisrooms_property_id,
        COALESCE(
          hotel_city_meta.name,
          hotel.hotel_city
        ) AS hotel_city_name,
        COALESCE(
          hotel_state_meta.name,
          hotel.hotel_state
        ) AS hotel_state_name,
        hotel.status
      ${fromSql}
      ORDER BY
        hotel.hotel_name ASC,
        hotel.hotel_id ASC
      LIMIT ?
      OFFSET ?
    `;

    const countRows =
      await this.prisma.$queryRawUnsafe<
        Array<{ total: bigint | number }>
      >(
        countSql,
        ...params,
      );

    const rows =
      await this.prisma.$queryRawUnsafe<
        HotelRow[]
      >(
        dataSql,
        ...params,
        limit,
        offset,
      );

    const total =
      Number(
        countRows[0]?.total ?? 0,
      );

    return {
      items: rows.map((hotel) => ({
        hotel_id:
          Number(hotel.hotel_id),

        hotel_name:
          hotel.hotel_name,

        hotel_code:
          hotel.hotel_code,

        hotel_email:
          hotel.hotel_email,

        hotel_mobile:
          hotel.hotel_mobile,

        hotel_city:
          hotel.hotel_city,

        hotel_state:
          hotel.hotel_state,

        hotel_city_name:
          hotel.hotel_city_name,

        hotel_state_name:
          hotel.hotel_state_name,

        city_name:
          hotel.hotel_city_name,

        state_name:
          hotel.hotel_state_name,

        hotel_address:
          hotel.hotel_address,

        axisrooms_property_id:
          hotel.axisrooms_property_id,

        status:
          hotel.status,
      })),

      pagination: {
        page,
        limit,
        total,
        totalPages:
          total === 0
            ? 0
            : Math.ceil(total / limit),
      },

      search,
    };
  }

  // HOTEL_ADMIN_ALL_ROOMS_INDEX
  async listRoomsIndex(
    userIdValue: unknown,
    options: {
      page?: unknown;
      limit?: unknown;
      search?: unknown;
    },
  ) {
    const user =
      await this.hotelAdminService
        .assertPermission(
          userIdValue,
          HotelAdminPermissionKey.ROOMS,
          'view',
        );

    const page =
      this.normalizePage(
        options.page,
      );

    const limit =
      this.normalizeLimit(
        options.limit,
      );

    const offset =
      (page - 1) * limit;

    const search =
      String(
        options.search ?? '',
      )
        .trim()
        .slice(0, 100);

    let countSql = `
      SELECT COUNT(*) AS total
      FROM dvi_hotel_admin_user_hotel AS assignment
      INNER JOIN dvi_hotel AS hotel
        ON hotel.hotel_id = assignment.hotel_id
      INNER JOIN dvi_hotel_rooms AS room
        ON room.hotel_id = assignment.hotel_id
      WHERE assignment.user_id = ?
        AND assignment.status = 1
        AND assignment.deleted = 0
        AND hotel.deleted = 0
        AND room.deleted = 0
    `;

    let dataSql = `
      SELECT
        room.room_ID,
        room.hotel_id,
        hotel.hotel_name,
        room.room_title,
        room.room_type_id,
        room.no_of_rooms_available,
        room.total_max_adults,
        room.total_max_childrens,
        room.air_conditioner_availability,
        room.check_in_time,
        room.check_out_time,
        room.status
      FROM dvi_hotel_admin_user_hotel AS assignment
      INNER JOIN dvi_hotel AS hotel
        ON hotel.hotel_id = assignment.hotel_id
      INNER JOIN dvi_hotel_rooms AS room
        ON room.hotel_id = assignment.hotel_id
      WHERE assignment.user_id = ?
        AND assignment.status = 1
        AND assignment.deleted = 0
        AND hotel.deleted = 0
        AND room.deleted = 0
    `;

    const countParams: any[] = [
      user.userID,
    ];

    const dataParams: any[] = [
      user.userID,
    ];

    if (search) {
      const searchClause = `
        AND (
          hotel.hotel_name LIKE ?
          OR hotel.hotel_code LIKE ?
          OR room.room_title LIKE ?
          OR CAST(room.room_type_id AS CHAR) LIKE ?
        )
      `;

      countSql += searchClause;
      dataSql += searchClause;

      const pattern =
        `%${search}%`;

      countParams.push(
        pattern,
        pattern,
        pattern,
        pattern,
      );

      dataParams.push(
        pattern,
        pattern,
        pattern,
        pattern,
      );
    }

    dataSql += `
      ORDER BY
        hotel.hotel_name ASC,
        room.room_title ASC,
        room.room_ID ASC
      LIMIT ?
      OFFSET ?
    `;

    dataParams.push(
      limit,
      offset,
    );

    const countRows =
      await this.prisma
        .$queryRawUnsafe<
          Array<{
            total:
              | bigint
              | number;
          }>
        >(
          countSql,
          ...countParams,
        );

    const rows =
      await this.prisma
        .$queryRawUnsafe<
          HotelAdminRoomIndexRow[]
        >(
          dataSql,
          ...dataParams,
        );

    const total =
      Number(
        countRows[0]
          ?.total ?? 0,
      );

    // HOTEL_ADMIN_ROOM_RATE_SUMMARY
    const roomIds =
      Array.from(
        new Set(
          rows.map(
            (room) =>
              Number(room.room_ID),
          ),
        ),
      ).filter(
        (id) =>
          Number.isInteger(id) &&
          id > 0,
      );

    const hotelIds =
      Array.from(
        new Set(
          rows.map(
            (room) =>
              Number(room.hotel_id),
          ),
        ),
      ).filter(
        (id) =>
          Number.isInteger(id) &&
          id > 0,
      );

    const rateRows =
      roomIds.length &&
      hotelIds.length
        ? await this.prisma
            .dvi_hotel_occupancy_rate
            .findMany({
              where: {
                hotel_id: {
                  in: hotelIds,
                },
                room_id: {
                  in: roomIds,
                },
              },
              select: {
                hotel_id: true,
                room_id: true,
                rateplan_id: true,
                occupancy_rates: true,
              },
            })
        : [];

    const roomRateSummary =
      new Map<
        string,
        {
          min: number | null;
          max: number | null;
          plans: Set<string>;
        }
      >();

    for (const rateRow of rateRows) {
      const key =
        `${rateRow.hotel_id}:${rateRow.room_id}`;

      let summary =
        roomRateSummary.get(key);

      if (!summary) {
        summary = {
          min: null,
          max: null,
          plans: new Set<string>(),
        };

        roomRateSummary.set(
          key,
          summary,
        );
      }

      const planId =
        String(
          rateRow.rateplan_id ?? '',
        ).trim();

      if (planId) {
        summary.plans.add(planId);
      }

      const rawRates =
        rateRow.occupancy_rates;

      if (
        !rawRates ||
        typeof rawRates !== 'object' ||
        Array.isArray(rawRates)
      ) {
        continue;
      }

      for (
        const [occupancy, rawValue]
        of Object.entries(
          rawRates as Record<string, unknown>,
        )
      ) {
        if (occupancy === 'ROOM_RATE') {
          continue;
        }

        const value =
          Number(rawValue);

        if (
          !Number.isFinite(value) ||
          value <= 0
        ) {
          continue;
        }

        summary.min =
          summary.min === null
            ? value
            : Math.min(
                summary.min,
                value,
              );

        summary.max =
          summary.max === null
            ? value
            : Math.max(
                summary.max,
                value,
              );
      }
    }

    return {
      items: rows.map(
        (room) => ({
          room_ID:
            Number(
              room.room_ID,
            ),

          hotel_id:
            Number(
              room.hotel_id,
            ),

          hotel_name:
            room.hotel_name,

          room_title:
            room.room_title,

          room_type_id:
            room.room_type_id ===
            null
              ? null
              : Number(
                  room.room_type_id,
                ),

          no_of_rooms_available:
            Number(
              room.no_of_rooms_available ??
                0,
            ),

          total_max_adults:
            Number(
              room.total_max_adults ??
                0,
            ),

          total_max_childrens:
            Number(
              room.total_max_childrens ??
                0,
            ),

          air_conditioner_availability:
            room
              .air_conditioner_availability,

          check_in_time:
            room.check_in_time,

          check_out_time:
            room.check_out_time,

          rate_min:
            roomRateSummary.get(
              `${Number(room.hotel_id)}:${Number(room.room_ID)}`,
            )?.min ?? null,

          rate_max:
            roomRateSummary.get(
              `${Number(room.hotel_id)}:${Number(room.room_ID)}`,
            )?.max ?? null,

          rate_plan_count:
            roomRateSummary.get(
              `${Number(room.hotel_id)}:${Number(room.room_ID)}`,
            )?.plans.size ?? 0,

          status:
            room.status,
        }),
      ),

      pagination: {
        page,
        limit,
        total,

        totalPages:
          total === 0
            ? 0
            : Math.ceil(
                total / limit,
              ),
      },

      search,
    };
  }
  async getDashboard(
    userIdValue: unknown,
  ) {
    const user =
      await this.requireHotelAdminUser(
        userIdValue,
      );

    const [
      hotelRows,
      roomRows,
      bookingRows,
      hotelUserRows,
    ] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{ total: bigint | number }>
      >`
        SELECT COUNT(*) AS total
        FROM dvi_hotel_admin_user_hotel AS assignment
        INNER JOIN dvi_hotel AS hotel
          ON hotel.hotel_id = assignment.hotel_id
        WHERE assignment.user_id = ${user.userID}
          AND assignment.status = 1
          AND assignment.deleted = 0
          AND hotel.deleted = 0
      `,

      this.prisma.$queryRaw<
        Array<{ total: bigint | number }>
      >`
        SELECT COUNT(*) AS total
        FROM dvi_hotel_admin_user_hotel AS assignment
        INNER JOIN dvi_hotel_rooms AS room
          ON room.hotel_id = assignment.hotel_id
        WHERE assignment.user_id = ${user.userID}
          AND assignment.status = 1
          AND assignment.deleted = 0
          AND room.status = 1
          AND room.deleted = 0
      `,

      this.prisma.$queryRaw<
        Array<{ total: bigint | number }>
      >`
        SELECT COUNT(*) AS total
        FROM dvi_hotel_admin_user_hotel AS assignment
        INNER JOIN dvi_confirmed_itinerary_plan_hotel_details AS booking
          ON booking.hotel_id = assignment.hotel_id
        WHERE assignment.user_id = ${user.userID}
          AND assignment.status = 1
          AND assignment.deleted = 0
          AND booking.status = 1
          AND booking.deleted = 0
      `,

      this.prisma.$queryRaw<
        Array<{ total: bigint | number }>
      >`
        SELECT COUNT(DISTINCT managed.user_id) AS total
        FROM dvi_hotel_admin_user_hotel AS actor
        INNER JOIN dvi_hotel_admin_user_hotel AS managed
          ON managed.hotel_id = actor.hotel_id
          AND managed.status = 1
          AND managed.deleted = 0
        INNER JOIN dvi_users AS hotel_user
          ON hotel_user.userID = managed.user_id
          AND hotel_user.roleID = ${SystemRole.HOTEL_ADMIN}
          AND hotel_user.deleted = 0
        WHERE actor.user_id = ${user.userID}
          AND actor.status = 1
          AND actor.deleted = 0
      `,
    ]);

    return {
      hotels:
        Number(
          hotelRows[0]?.total ?? 0,
        ),

      hotelUsers:
        Number(
          hotelUserRows[0]?.total ?? 0,
        ),

      rooms:
        Number(
          roomRows[0]?.total ?? 0,
        ),

      activeBookings:
        Number(
          bookingRows[0]?.total ?? 0,
        ),
    };
  }
}