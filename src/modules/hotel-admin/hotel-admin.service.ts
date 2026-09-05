import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma.service';
import { HotelsService } from '../hotels/hotels.service';
import { SystemRole } from '../auth/constants/system-role.constants';
import {
  HOTEL_ADMIN_PERMISSION_KEYS,
  HotelAdminPermissionAction,
  HotelAdminPermissionInput,
  HotelAdminPermissionKey,
} from './hotel-admin-permissions';
import {
  CreateHotelAdminUserDto,
  SetHotelAdminPermissionsDto,
  UpdateHotelAdminUserDto,
} from './dto/hotel-admin-user.dto';

@Injectable()
export class HotelAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hotelsService: HotelsService,
  ) {}

  private parseUserId(value: unknown): bigint {
    try {
      const id = BigInt(String(value ?? '0'));

      if (id <= 0n) {
        throw new Error();
      }

      return id;
    } catch {
      throw new ForbiddenException(
        'Invalid authenticated Hotel Admin user',
      );
    }
  }

  private normalizeEmail(value: unknown): string {
    return String(value ?? '')
      .trim()
      .toLowerCase();
  }

  private async requireHotelAdminUser(
    userIdValue: unknown,
  ) {
    const userId =
      this.parseUserId(userIdValue);

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
          status: true,
        },
      });

    if (!user) {
      throw new ForbiddenException(
        'Active Hotel Admin account required',
      );
    }

    return user;
  }

  private async getAssignedHotelIds(
    userId: bigint,
  ): Promise<number[]> {
    const rows =
      await this.prisma
        .dvi_hotel_admin_user_hotel
        .findMany({
          where: {
            user_id: userId,
            status: 1,
            deleted: 0,
          },
          select: {
            hotel_id: true,
          },
          orderBy: {
            hotel_id: 'asc',
          },
        });

    return rows.map(
      (row) => Number(row.hotel_id),
    );
  }

  private async getPermissionRows(
    userId: bigint,
  ) {
    return this.prisma
      .dvi_hotel_admin_user_permission
      .findMany({
        where: {
          user_id: userId,
          status: 1,
          deleted: 0,
        },
        orderBy: {
          permission_key: 'asc',
        },
      });
  }

  async assertPermission(
    userIdValue: unknown,
    key: string,
    action: HotelAdminPermissionAction,
  ) {
    const user =
      await this.requireHotelAdminUser(
        userIdValue,
      );

    if (
      !HOTEL_ADMIN_PERMISSION_KEYS.includes(
        key as any,
      )
    ) {
      throw new ForbiddenException(
        'Unknown Hotel Admin permission',
      );
    }

    const row =
      await this.prisma
        .dvi_hotel_admin_user_permission
        .findFirst({
          where: {
            user_id: user.userID,
            permission_key: key,
            status: 1,
            deleted: 0,
          },
        });

    const allowed =
      action === 'view'
        ? row?.can_view === 1
        : action === 'create'
          ? row?.can_create === 1
          : action === 'edit'
            ? row?.can_edit === 1
            : row?.can_delete === 1;

    if (!allowed) {
      throw new ForbiddenException(
        `Hotel Admin permission denied: ${key}:${action}`,
      );
    }

    return user;
  }

  async assertAssignedHotel(
    userIdValue: unknown,
    hotelId: number,
  ) {
    const user =
      await this.requireHotelAdminUser(
        userIdValue,
      );

    const assignment =
      await this.prisma
        .dvi_hotel_admin_user_hotel
        .findFirst({
          where: {
            user_id: user.userID,
            hotel_id: hotelId,
            status: 1,
            deleted: 0,
          },
        });

    if (!assignment) {
      throw new ForbiddenException(
        'This Hotel Admin is not assigned to the requested hotel',
      );
    }

    return user;
  }

  private validatePermissionPayload(
    permissions: HotelAdminPermissionInput[],
  ) {
    const seen = new Set<string>();

    for (const permission of permissions) {
      if (
        !HOTEL_ADMIN_PERMISSION_KEYS.includes(
          permission.key as any,
        )
      ) {
        throw new BadRequestException(
          `Unknown Hotel Admin permission key: ${permission.key}`,
        );
      }

      if (seen.has(permission.key)) {
        throw new BadRequestException(
          `Duplicate permission key: ${permission.key}`,
        );
      }

      seen.add(permission.key);
    }
  }

  private async assertHotelsSubset(
    actorUserId: bigint,
    requestedHotelIds: number[],
  ) {
    const actorHotelIds =
      await this.getAssignedHotelIds(
        actorUserId,
      );

    const allowed =
      new Set(actorHotelIds);

    for (const hotelId of requestedHotelIds) {
      if (!allowed.has(Number(hotelId))) {
        throw new ForbiddenException(
          `Cannot assign hotel ${hotelId}`,
        );
      }
    }
  }

  private async assertCanGrantPermissions(
    actorUserId: bigint,
    permissions: HotelAdminPermissionInput[],
  ) {
    this.validatePermissionPayload(
      permissions,
    );

    const actorRows =
      await this.getPermissionRows(
        actorUserId,
      );

    const actorMap =
      new Map(
        actorRows.map((row) => [
          row.permission_key,
          row,
        ]),
      );

    for (const permission of permissions) {
      const actor =
        actorMap.get(permission.key);

      if (
        permission.view &&
        actor?.can_view !== 1
      ) {
        throw new ForbiddenException(
          `Cannot grant ${permission.key}:view`,
        );
      }

      if (
        permission.create &&
        actor?.can_create !== 1
      ) {
        throw new ForbiddenException(
          `Cannot grant ${permission.key}:create`,
        );
      }

      if (
        permission.edit &&
        actor?.can_edit !== 1
      ) {
        throw new ForbiddenException(
          `Cannot grant ${permission.key}:edit`,
        );
      }

      if (
        permission.delete &&
        actor?.can_delete !== 1
      ) {
        throw new ForbiddenException(
          `Cannot grant ${permission.key}:delete`,
        );
      }
    }
  }

  private async syncAssignments(
    userId: bigint,
    hotelIds: number[],
    createdBy: bigint,
  ) {
    const now = new Date();

    await this.prisma
      .dvi_hotel_admin_user_hotel
      .updateMany({
        where: {
          user_id: userId,
          deleted: 0,
        },
        data: {
          status: 0,
          deleted: 1,
          updatedon: now,
        },
      });

    for (const hotelId of hotelIds) {
      const existing =
        await this.prisma
          .dvi_hotel_admin_user_hotel
          .findFirst({
            where: {
              user_id: userId,
              hotel_id: Number(hotelId),
            },
          });

      if (existing) {
        await this.prisma
          .dvi_hotel_admin_user_hotel
          .update({
            where: {
              hotel_admin_user_hotel_id:
                existing.hotel_admin_user_hotel_id,
            },
            data: {
              status: 1,
              deleted: 0,
              createdby: createdBy,
              updatedon: now,
            },
          });
      } else {
        await this.prisma
          .dvi_hotel_admin_user_hotel
          .create({
            data: {
              user_id: userId,
              hotel_id: Number(hotelId),
              createdby: createdBy,
              createdon: now,
              updatedon: now,
              status: 1,
              deleted: 0,
            },
          });
      }
    }
  }

  private async syncPermissions(
    userId: bigint,
    permissions: HotelAdminPermissionInput[],
    createdBy: bigint,
  ) {
    const now = new Date();

    await this.prisma
      .dvi_hotel_admin_user_permission
      .updateMany({
        where: {
          user_id: userId,
          deleted: 0,
        },
        data: {
          status: 0,
          deleted: 1,
          updatedon: now,
        },
      });

    for (const permission of permissions) {
      const existing =
        await this.prisma
          .dvi_hotel_admin_user_permission
          .findFirst({
            where: {
              user_id: userId,
              permission_key:
                permission.key,
            },
          });

      const values = {
        can_view:
          permission.view ? 1 : 0,
        can_create:
          permission.create ? 1 : 0,
        can_edit:
          permission.edit ? 1 : 0,
        can_delete:
          permission.delete ? 1 : 0,
        createdby: createdBy,
        updatedon: now,
        status: 1,
        deleted: 0,
      };

      if (existing) {
        await this.prisma
          .dvi_hotel_admin_user_permission
          .update({
            where: {
              hotel_admin_user_permission_id:
                existing.hotel_admin_user_permission_id,
            },
            data: values,
          });
      } else {
        await this.prisma
          .dvi_hotel_admin_user_permission
          .create({
            data: {
              user_id: userId,
              permission_key:
                permission.key,
              ...values,
              createdon: now,
            },
          });
      }
    }
  }

  async getContext(
    userIdValue: unknown,
  ) {
    const user =
      await this.requireHotelAdminUser(
        userIdValue,
      );

    const hotelIds =
      await this.getAssignedHotelIds(
        user.userID,
      );

    const hotels = hotelIds.length
      ? await this.prisma.dvi_hotel.findMany({
          where: {
            hotel_id: {
              in: hotelIds,
            },
            deleted: false,
          },
          select: {
            hotel_id: true,
            hotel_name: true,
            hotel_code: true,
            hotel_email: true,
            hotel_mobile: true,
            hotel_city: true,
            hotel_state: true,
            hotel_address: true,
            status: true,
          },
          orderBy: {
            hotel_name: 'asc',
          },
        })
      : [];

    const rows =
      await this.getPermissionRows(
        user.userID,
      );

    return {
      user: {
        id: user.userID.toString(),
        email: user.useremail ?? '',
        fullName: user.username ?? '',
        roleID: Number(user.roleID),
      },
      hotelIds,
      hotels,
      permissions: rows.map((row) => ({
        key: row.permission_key,
        view: row.can_view === 1,
        create:
          row.can_create === 1,
        edit: row.can_edit === 1,
        delete:
          row.can_delete === 1,
      })),
    };
  }

  async getDashboard(
    userIdValue: unknown,
  ) {
    const user =
      await this.requireHotelAdminUser(
        userIdValue,
      );

    const hotelIds =
      await this.getAssignedHotelIds(
        user.userID,
      );

    if (!hotelIds.length) {
      return {
        hotels: 0,
        hotelUsers: 0,
        rooms: 0,
        activeBookings: 0,
      };
    }

    const [
      roomCount,
      bookingCount,
      userAssignments,
    ] = await Promise.all([
      this.prisma.dvi_hotel_rooms.count({
        where: {
          hotel_id: {
            in: hotelIds,
          },
          status: 1,
          deleted: 0,
        },
      }),

      this.prisma
        .dvi_confirmed_itinerary_plan_hotel_details
        .count({
          where: {
            hotel_id: {
              in: hotelIds,
            },
            status: 1,
            deleted: 0,
          },
        }),

      this.prisma
        .dvi_hotel_admin_user_hotel
        .findMany({
          where: {
            hotel_id: {
              in: hotelIds,
            },
            status: 1,
            deleted: 0,
          },
          select: {
            user_id: true,
          },
        }),
    ]);

    return {
      hotels: hotelIds.length,
      hotelUsers:
        new Set(
          userAssignments.map(
            (row) => row.user_id.toString(),
          ),
        ).size,
      rooms: roomCount,
      activeBookings: bookingCount,
    };
  }

  async listAssignedHotels(
    userIdValue: unknown,
  ) {
    const user =
      await this.assertPermission(
        userIdValue,
        HotelAdminPermissionKey.HOTELS,
        'view',
      );

    const hotelIds =
      await this.getAssignedHotelIds(
        user.userID,
      );

    if (!hotelIds.length) {
      return [];
    }

    return this.prisma.dvi_hotel.findMany({
      where: {
        hotel_id: {
          in: hotelIds,
        },
        deleted: false,
      },
      orderBy: {
        hotel_name: 'asc',
      },
    });
  }

  async getHotel(
    userIdValue: unknown,
    hotelId: number,
  ) {
    await this.assertPermission(
      userIdValue,
      HotelAdminPermissionKey.HOTEL_DETAILS,
      'view',
    );

    await this.assertAssignedHotel(
      userIdValue,
      hotelId,
    );

    return this.hotelsService.getOne(
      hotelId,
    );
  }

  async updateHotel(
    userIdValue: unknown,
    hotelId: number,
    body: any,
  ) {
    await this.assertPermission(
      userIdValue,
      HotelAdminPermissionKey.HOTEL_DETAILS,
      'edit',
    );

    await this.assertAssignedHotel(
      userIdValue,
      hotelId,
    );

    return this.hotelsService.update(
      hotelId,
      body,
    );
  }

  async listRooms(
    userIdValue: unknown,
    hotelId: number,
  ) {
    await this.assertPermission(
      userIdValue,
      HotelAdminPermissionKey.ROOMS,
      'view',
    );

    await this.assertAssignedHotel(
      userIdValue,
      hotelId,
    );

    return this.hotelsService.listRooms(
      hotelId,
    );
  }

  async createRoom(
    userIdValue: unknown,
    hotelId: number,
    body: any,
  ) {
    await this.assertPermission(
      userIdValue,
      HotelAdminPermissionKey.ROOMS,
      'create',
    );

    await this.assertAssignedHotel(
      userIdValue,
      hotelId,
    );

    return this.hotelsService.addRoom({
      ...(body ?? {}),
      hotel_id: hotelId,
    } as any);
  }

  async updateRoom(
    userIdValue: unknown,
    hotelId: number,
    roomId: number,
    body: any,
  ) {
    await this.assertPermission(
      userIdValue,
      HotelAdminPermissionKey.ROOMS,
      'edit',
    );

    await this.assertAssignedHotel(
      userIdValue,
      hotelId,
    );

    return this.hotelsService.updateRoom({
      ...(body ?? {}),
      hotel_id: hotelId,
      room_ID: roomId,
    } as any);
  }

  async deleteRoom(
    userIdValue: unknown,
    hotelId: number,
    roomId: number,
  ) {
    await this.assertPermission(
      userIdValue,
      HotelAdminPermissionKey.ROOMS,
      'delete',
    );

    await this.assertAssignedHotel(
      userIdValue,
      hotelId,
    );

    return this.hotelsService.removeRoom(
      hotelId,
      roomId,
    );
  }

  async listRatePlans(
    userIdValue: unknown,
    hotelId: number,
    roomId: number,
  ) {
    const actor =
      await this.assertPermission(
        userIdValue,
        HotelAdminPermissionKey.RATES,
        'view',
      );

    await this.assertAssignedHotel(
      actor.userID,
      hotelId,
    );

    if (
      !Number.isInteger(roomId) ||
      roomId <= 0
    ) {
      throw new BadRequestException(
        'roomId must be a valid number',
      );
    }

    const room =
      await this.prisma.dvi_hotel_rooms.findFirst({
        where: {
          hotel_id: hotelId,
          room_ID: BigInt(roomId),
          deleted: 0,
        },
        select: {
          room_ID: true,
          room_title: true,
        },
      });

    if (!room) {
      throw new BadRequestException(
        'Room not found for this hotel',
      );
    }

    const rows =
      await this.prisma.dvi_hotel_room_rate_plan.findMany({
        where: {
          hotel_id: hotelId,
          room_id: roomId,
          status: 1,
          deleted: 0,
        },
        select: {
          hotel_room_rate_plan_id: true,
          rateplan_id: true,
          rateplan_name: true,
          rate_plan_code: true,
          meal_plan_description: true,
          currency: true,
          occupancy: true,
        },
        orderBy: {
          hotel_room_rate_plan_id: 'asc',
        },
      });

    return {
      room: {
        id: Number(room.room_ID),
        name: room.room_title ?? '',
      },
      items: rows.map((row) => ({
        id: row.hotel_room_rate_plan_id,
        rateplanId: row.rateplan_id,
        name: row.rateplan_name,
        code: row.rate_plan_code,
        mealPlan:
          row.meal_plan_description,
        currency: row.currency,
        occupancy: row.occupancy,
      })),
    };
  }
  async getRates(
    userIdValue: unknown,
    hotelId: number,
    query: {
      startDate: string;
      endDate: string;
      roomId: number;
      rateplanId: string;
    },
  ) {
    await this.assertPermission(
      userIdValue,
      HotelAdminPermissionKey.RATES,
      'view',
    );

    await this.assertAssignedHotel(
      userIdValue,
      hotelId,
    );

    return this.hotelsService
      .getRoomPricebookRangeView(
        hotelId,
        query,
      );
  }

  async saveRates(
    userIdValue: unknown,
    hotelId: number,
    body: any,
  ) {
    await this.assertPermission(
      userIdValue,
      HotelAdminPermissionKey.RATES,
      'edit',
    );

    await this.assertAssignedHotel(
      userIdValue,
      hotelId,
    );

    return this.hotelsService
      .bulkUpsertRoomPricebook(
        hotelId,
        body as any,
      );
  }

  async getAvailability(
    userIdValue: unknown,
    hotelId: number,
    roomId: number,
    startDate: string,
    endDate: string,
  ) {
    await this.assertPermission(
      userIdValue,
      HotelAdminPermissionKey.AVAILABILITY,
      'view',
    );

    await this.assertAssignedHotel(
      userIdValue,
      hotelId,
    );

    return this.hotelsService
      .getRoomAvailabilityRangeView(
        hotelId,
        {
          roomId,
          startDate,
          endDate,
        },
      );
  }

  async saveAvailability(
    userIdValue: unknown,
    hotelId: number,
    roomId: number,
    items: Array<{
      startDate?: string;
      endDate?: string;
      freeRooms?: number;
    }>,
  ) {
    await this.assertPermission(
      userIdValue,
      HotelAdminPermissionKey.AVAILABILITY,
      'edit',
    );

    await this.assertAssignedHotel(
      userIdValue,
      hotelId,
    );

    return this.hotelsService
      .saveRoomAvailability(
        hotelId,
        roomId,
        items,
      );
  }

  async listBookings(
    userIdValue: unknown,
  ) {
    const user =
      await this.assertPermission(
        userIdValue,
        HotelAdminPermissionKey.BOOKINGS,
        'view',
      );

    const hotelIds =
      await this.getAssignedHotelIds(
        user.userID,
      );

    if (!hotelIds.length) {
      return [];
    }

    const rows =
      await this.prisma
        .dvi_confirmed_itinerary_plan_hotel_details
        .findMany({
          where: {
            hotel_id: {
              in: hotelIds,
            },
            deleted: 0,
          },
          select: {
            confirmed_itinerary_plan_hotel_details_ID:
              true,
            itinerary_plan_id: true,
            itinerary_route_id: true,
            hotel_id: true,
            hotel_code: true,
            itinerary_route_date: true,
            hotel_check_in_date: true,
            hotel_check_out_date: true,
            total_no_of_rooms: true,
            total_hotel_cost: true,
            hotel_approval_status: true,
            manual_confirmation_status:
              true,
            status: true,
          },
          orderBy: {
            itinerary_route_date:
              'desc',
          },
          take: 500,
        });

    return rows.map((row) => ({
      bookingId:
        row.confirmed_itinerary_plan_hotel_details_ID,
      itineraryPlanId:
        row.itinerary_plan_id,
      itineraryRouteId:
        row.itinerary_route_id,
      hotelId: row.hotel_id,
      hotelCode:
        row.hotel_code,
      routeDate:
        row.itinerary_route_date,
      checkIn:
        row.hotel_check_in_date,
      checkOut:
        row.hotel_check_out_date,
      rooms:
        row.total_no_of_rooms,
      total:
        row.total_hotel_cost,
      approvalStatus:
        row.hotel_approval_status,
      confirmationStatus:
        row.manual_confirmation_status,
      status:
        row.status,
    }));
  }

  private async findHotelAdminUser(
    userId: bigint,
  ) {
    const user =
      await this.prisma.dvi_users.findFirst({
        where: {
          userID: userId,
          roleID:
            SystemRole.HOTEL_ADMIN,
          deleted: 0,
        },
      });

    if (!user) {
      throw new NotFoundException(
        'Hotel Admin user not found',
      );
    }

    return user;
  }

  private async assertManageableUser(
    actorUserId: bigint,
    targetUserId: bigint,
  ) {
    await this.findHotelAdminUser(
      targetUserId,
    );

    const actorHotels =
      new Set(
        await this.getAssignedHotelIds(
          actorUserId,
        ),
      );

    const targetHotels =
      await this.getAssignedHotelIds(
        targetUserId,
      );

    for (const hotelId of targetHotels) {
      if (!actorHotels.has(hotelId)) {
        throw new ForbiddenException(
          'Cannot manage a Hotel Admin assigned outside your hotels',
        );
      }
    }
  }

  private async assertTargetSharesManagedHotel(
    actorUserId: bigint,
    targetUserId: bigint,
  ) {
    if (actorUserId === targetUserId) {
      return;
    }

    const rows =
      await this.prisma.$queryRaw<
        Array<{ ok: number }>
      >`
        SELECT 1 AS ok
        FROM dvi_hotel_admin_user_hotel AS actor_assignment
        INNER JOIN dvi_hotel_admin_user_hotel AS target_assignment
          ON target_assignment.hotel_id = actor_assignment.hotel_id
        INNER JOIN dvi_users AS target_user
          ON target_user.userID = target_assignment.user_id
        WHERE actor_assignment.user_id = ${actorUserId}
          AND actor_assignment.status = 1
          AND actor_assignment.deleted = 0
          AND target_assignment.user_id = ${targetUserId}
          AND target_assignment.status = 1
          AND target_assignment.deleted = 0
          AND target_user.roleID = ${SystemRole.HOTEL_ADMIN}
          AND target_user.deleted = 0
        LIMIT 1
      `;

    if (!rows.length) {
      throw new BadRequestException(
        'Hotel Admin user is outside your assigned hotels',
      );
    }
  }
  async listHotelUsers(
    userIdValue: unknown,
  ) {
    const actor =
      await this.assertPermission(
        userIdValue,
        HotelAdminPermissionKey.HOTEL_USERS,
        'view',
      );

    const actorHotels =
      await this.getAssignedHotelIds(
        actor.userID,
      );

    if (!actorHotels.length) {
      return [];
    }

    const assignments =
      await this.prisma
        .dvi_hotel_admin_user_hotel
        .findMany({
          where: {
            hotel_id: {
              in: actorHotels,
            },
            status: 1,
            deleted: 0,
          },
          select: {
            user_id: true,
            hotel_id: true,
          },
        });

    const userIds =
      Array.from(
        new Set(
          assignments.map(
            (row) =>
              row.user_id.toString(),
          ),
        ),
      ).map((value) =>
        BigInt(value),
      );

    if (!userIds.length) {
      return [];
    }

    const users =
      await this.prisma.dvi_users.findMany({
        where: {
          userID: {
            in: userIds,
          },
          roleID:
            SystemRole.HOTEL_ADMIN,
          deleted: 0,
        },
        select: {
          userID: true,
          username: true,
          useremail: true,
          status: true,
        },
        orderBy: {
          username: 'asc',
        },
      });

    const hotelMap =
      new Map<string, number[]>();

    for (const assignment of assignments) {
      const key =
        assignment.user_id.toString();

      const list =
        hotelMap.get(key) ?? [];

      list.push(
        Number(
          assignment.hotel_id,
        ),
      );

      hotelMap.set(
        key,
        list,
      );
    }

    return users.map((user) => ({
      id: user.userID.toString(),
      name:
        user.username ?? '',
      email:
        user.useremail ?? '',
      active:
        Number(user.status) === 1,
      hotelIds:
        hotelMap.get(
          user.userID.toString(),
        ) ?? [],
    }));
  }

  async createHotelUser(
    userIdValue: unknown,
    dto: CreateHotelAdminUserDto,
  ) {
    const actor =
      await this.assertPermission(
        userIdValue,
        HotelAdminPermissionKey.HOTEL_USERS,
        'create',
      );

    const hotelIds =
      Array.from(
        new Set(
          dto.hotelIds.map(Number),
        ),
      );

    if (!hotelIds.length) {
      throw new BadRequestException(
        'At least one hotel assignment is required',
      );
    }

    await this.assertHotelsSubset(
      actor.userID,
      hotelIds,
    );

    const permissions =
      dto.permissions ?? [];

    await this.assertCanGrantPermissions(
      actor.userID,
      permissions,
    );

    const email =
      this.normalizeEmail(
        dto.email,
      );

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
        dto.password,
        10,
      );

    const now = new Date();

    const user =
      await this.prisma.dvi_users.create({
        data: {
          username:
            dto.name.trim(),
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

    try {
      await this.syncAssignments(
        user.userID,
        hotelIds,
        actor.userID,
      );

      await this.syncPermissions(
        user.userID,
        permissions,
        actor.userID,
      );
    } catch (error) {
      const failedAt = new Date();

      await this.prisma.$transaction([
        this.prisma.dvi_users.update({
          where: {
            userID:
              user.userID,
          },
          data: {
            status: 0,
            deleted: 1,
            updatedon:
              failedAt,
          },
        }),

        this.prisma
          .dvi_hotel_admin_user_hotel
          .updateMany({
            where: {
              user_id:
                user.userID,
              deleted: 0,
            },
            data: {
              status: 0,
              deleted: 1,
              updatedon:
                failedAt,
            },
          }),

        this.prisma
          .dvi_hotel_admin_user_permission
          .updateMany({
            where: {
              user_id:
                user.userID,
              deleted: 0,
            },
            data: {
              status: 0,
              deleted: 1,
              updatedon:
                failedAt,
            },
          }),
      ]);

      throw error;
    }

    return {
      id:
        user.userID.toString(),
      email,
      roleID:
        SystemRole.HOTEL_ADMIN,
    };
  }

  async updateHotelUser(
    userIdValue: unknown,
    targetUserIdValue: unknown,
    dto: UpdateHotelAdminUserDto,
  ) {
    const actor =
      await this.assertPermission(
        userIdValue,
        HotelAdminPermissionKey.HOTEL_USERS,
        'edit',
      );

    const targetUserId =
      this.parseUserId(
        targetUserIdValue,
      );

    await this.assertManageableUser(
      actor.userID,
      targetUserId,
    );

    await this.assertTargetSharesManagedHotel(
      actor.userID,
      targetUserId,
    );

    let requestedHotelIds:
      number[] | null = null;

    if (dto.hotelIds !== undefined) {
      requestedHotelIds =
        Array.from(
          new Set(
            dto.hotelIds.map(Number),
          ),
        );

      if (
        !requestedHotelIds.length ||
        requestedHotelIds.some(
          (hotelId) =>
            !Number.isInteger(hotelId) ||
            hotelId <= 0,
        )
      ) {
        throw new BadRequestException(
          'At least one valid hotel assignment is required',
        );
      }

      await this.assertHotelsSubset(
        actor.userID,
        requestedHotelIds,
      );
    }

    const data: any = {
      updatedon:
        new Date(),
    };

    if (
      dto.name !== undefined
    ) {
      data.username =
        dto.name.trim();
    }

    if (
      dto.active !== undefined
    ) {
      data.status =
        dto.active ? 1 : 0;
    }

    if (
      dto.password
    ) {
      data.password =
        await bcrypt.hash(
          dto.password,
          10,
        );
    }

    await this.prisma.dvi_users.update({
      where: {
        userID:
          targetUserId,
      },
      data,
    });

    if (requestedHotelIds) {
      await this.syncAssignments(
        targetUserId,
        requestedHotelIds,
        actor.userID,
      );
    }

    return {
      ok: true,
    };
  }
  async deleteHotelUser(
    userIdValue: unknown,
    targetUserIdValue: unknown,
  ) {
    const actor =
      await this.assertPermission(
        userIdValue,
        HotelAdminPermissionKey.HOTEL_USERS,
        'delete',
      );

    const targetUserId =
      this.parseUserId(
        targetUserIdValue,
      );

    if (
      actor.userID ===
      targetUserId
    ) {
      throw new BadRequestException(
        'A Hotel Admin cannot delete their own account',
      );
    }

    await this.assertManageableUser(
      actor.userID,
      targetUserId,
    );

    await this.assertTargetSharesManagedHotel(
      actor.userID,
      targetUserId,
    );

    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.dvi_users.update({
        where: {
          userID:
            targetUserId,
        },
        data: {
          status: 0,
          deleted: 1,
          updatedon: now,
        },
      }),

      this.prisma
        .dvi_hotel_admin_user_hotel
        .updateMany({
          where: {
            user_id:
              targetUserId,
            deleted: 0,
          },
          data: {
            status: 0,
            deleted: 1,
            updatedon: now,
          },
        }),

      this.prisma
        .dvi_hotel_admin_user_permission
        .updateMany({
          where: {
            user_id:
              targetUserId,
            deleted: 0,
          },
          data: {
            status: 0,
            deleted: 1,
            updatedon: now,
          },
        }),
    ]);

    return {
      ok: true,
    };
  }

  async getUserPermissions(
    userIdValue: unknown,
    targetUserIdValue: unknown,
  ) {
    const actor =
      await this.assertPermission(
        userIdValue,
        HotelAdminPermissionKey.PERMISSIONS,
        'view',
      );

    const targetUserId =
      this.parseUserId(
        targetUserIdValue,
      );

    await this.assertManageableUser(
      actor.userID,
      targetUserId,
    );

    await this.assertTargetSharesManagedHotel(
      actor.userID,
      targetUserId,
    );

    const rows =
      await this.getPermissionRows(
        targetUserId,
      );

    return rows.map((row) => ({
      key:
        row.permission_key,
      view:
        row.can_view === 1,
      create:
        row.can_create === 1,
      edit:
        row.can_edit === 1,
      delete:
        row.can_delete === 1,
    }));
  }

  async setUserPermissions(
    userIdValue: unknown,
    targetUserIdValue: unknown,
    dto: SetHotelAdminPermissionsDto,
  ) {
    const actor =
      await this.assertPermission(
        userIdValue,
        HotelAdminPermissionKey.PERMISSIONS,
        'edit',
      );

    const targetUserId =
      this.parseUserId(
        targetUserIdValue,
      );

    await this.assertManageableUser(
      actor.userID,
      targetUserId,
    );

    await this.assertTargetSharesManagedHotel(
      actor.userID,
      targetUserId,
    );

    await this.assertCanGrantPermissions(
      actor.userID,
      dto.permissions,
    );

    await this.syncPermissions(
      targetUserId,
      dto.permissions,
      actor.userID,
    );

    return {
      ok: true,
    };
  }
}