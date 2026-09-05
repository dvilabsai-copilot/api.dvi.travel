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
  status: number | boolean | null;
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

    let countSql = `
      SELECT COUNT(*) AS total
      FROM dvi_hotel_admin_user_hotel AS assignment
      INNER JOIN dvi_hotel AS hotel
        ON hotel.hotel_id = assignment.hotel_id
      WHERE assignment.user_id = ?
        AND assignment.status = 1
        AND assignment.deleted = 0
        AND hotel.deleted = 0
    `;

    let dataSql = `
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
      WHERE assignment.user_id = ?
        AND assignment.status = 1
        AND assignment.deleted = 0
        AND hotel.deleted = 0
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
          OR hotel.hotel_city LIKE ?
          OR hotel.hotel_state LIKE ?
        )
      `;

      countSql += searchClause;
      dataSql += searchClause;

      const pattern = `%${search}%`;

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
        hotel.hotel_id ASC
      LIMIT ?
      OFFSET ?
    `;

    dataParams.push(
      limit,
      offset,
    );

    const countRows =
      await this.prisma.$queryRawUnsafe<
        Array<{ total: bigint | number }>
      >(
        countSql,
        ...countParams,
      );

    const rows =
      await this.prisma.$queryRawUnsafe<
        HotelRow[]
      >(
        dataSql,
        ...dataParams,
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
        hotel_address:
          hotel.hotel_address,
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