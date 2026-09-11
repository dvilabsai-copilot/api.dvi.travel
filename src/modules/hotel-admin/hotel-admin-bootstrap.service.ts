import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma.service';
import {
  SystemRole,
} from '../auth/constants/system-role.constants';
import {
  CreateHotelAdminUserDto,
} from './dto/hotel-admin-user.dto';
import {
  HotelAdminPermissionKey,
} from './hotel-admin-permissions';

@Injectable()
export class HotelAdminBootstrapService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  private parseActorId(
    value: unknown,
  ): bigint {
    try {
      const id = BigInt(
        String(value ?? '0'),
      );

      if (id <= 0n) {
        throw new Error();
      }

      return id;
    } catch {
      throw new ForbiddenException(
        'Invalid authenticated user',
      );
    }
  }

  async createBySuperAdmin(
    actorUserIdValue: unknown,
    dto: CreateHotelAdminUserDto,
  ) {
    const actorUserId =
      this.parseActorId(
        actorUserIdValue,
      );

    const actor =
      await this.prisma.dvi_users.findFirst({
        where: {
          userID: actorUserId,
          roleID: SystemRole.ADMIN,
          status: 1,
          deleted: 0,
        },
        select: {
          userID: true,
        },
      });

    if (!actor) {
      throw new ForbiddenException(
        'Super Admin access required',
      );
    }

    const name =
      String(dto.name ?? '').trim();

    const email =
      String(dto.email ?? '')
        .trim()
        .toLowerCase();

    const password =
      String(dto.password ?? '');

    const hotelIds =
      Array.from(
        new Set(
          (dto.hotelIds ?? [])
            .map(Number),
        ),
      );

    if (name.length < 2) {
      throw new BadRequestException(
        'Hotel Admin name is required',
      );
    }

    if (!email) {
      throw new BadRequestException(
        'Hotel Admin email is required',
      );
    }

    if (password.length < 8) {
      throw new BadRequestException(
        'Password must contain at least 8 characters',
      );
    }

    if (
      !hotelIds.length ||
      hotelIds.some(
        (hotelId) =>
          !Number.isInteger(hotelId) ||
          hotelId <= 0,
      )
    ) {
      throw new BadRequestException(
        'At least one valid hotel assignment is required',
      );
    }

    const hotels =
      await this.prisma.dvi_hotel.findMany({
        where: {
          hotel_id: {
            in: hotelIds,
          },
          status: 1,
          deleted: false,
        },
        select: {
          hotel_id: true,
        },
      });

    const validHotelIds =
      new Set(
        hotels.map(
          (hotel) =>
            Number(hotel.hotel_id),
        ),
      );

    const missingHotelIds =
      hotelIds.filter(
        (hotelId) =>
          !validHotelIds.has(hotelId),
      );

    if (missingHotelIds.length) {
      throw new BadRequestException(
        `Invalid or inactive hotel IDs: ${missingHotelIds.join(', ')}`,
      );
    }

    const existing =
      await this.prisma.$queryRaw<
        Array<{ userID: bigint }>
      >`
        SELECT userID
        FROM dvi_users
        WHERE LOWER(TRIM(useremail)) = ${email}
          AND deleted = 0
        LIMIT 1
      `;

    if (existing.length) {
      throw new ConflictException(
        'A user with this email already exists',
      );
    }

    const passwordHash =
      await bcrypt.hash(
        password,
        10,
      );

    const now = new Date();

    return this.prisma.$transaction(
      async (tx) => {
        const user =
          await tx.dvi_users.create({
            data: {
              username: name,
              useremail: email,
              password:
                passwordHash,
              roleID:
                SystemRole.HOTEL_ADMIN,
              userapproved: 1,
              userbanned: 0,
              status: 1,
              deleted: 0,
              createdby:
                actor.userID,
              createdon: now,
              updatedon: now,
            },
          });

        for (
          const hotelId of hotelIds
        ) {
          await tx
            .dvi_hotel_admin_user_hotel
            .create({
              data: {
                user_id:
                  user.userID,
                hotel_id:
                  hotelId,
                createdby:
                  actor.userID,
                createdon: now,
                updatedon: now,
                status: 1,
                deleted: 0,
              },
            });
        }

        await tx
          .dvi_hotel_admin_user_permission
          .create({
            data: {
              user_id:
                user.userID,
              permission_key:
                HotelAdminPermissionKey
                  .BOOKINGS,
              can_view: 1,
              can_create: 0,
              can_edit: 1,
              can_delete: 0,
              createdby:
                actor.userID,
              createdon: now,
              updatedon: now,
              status: 1,
              deleted: 0,
            },
          });

        return {
          ok: true,
          id:
            user.userID.toString(),
          email,
          roleID:
            SystemRole.HOTEL_ADMIN,
          hotelIds,
          permissions: [
            {
              key:
                HotelAdminPermissionKey
                  .BOOKINGS,
              view: true,
              edit: true,
            },
          ],
        };
      },
    );
  }
}
