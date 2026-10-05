import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma.service';

import {
  SystemRole,
  isAgentRoleChangeTarget,
} from '../auth/constants/system-role.constants';

type LockedAgentRow = {
  agent_ID: number;
  agent_name: string | null;
  agent_lastname: string | null;
  agent_email_id: string | null;
  agent_primary_mobile_number:
    string | null;
  status: number | null;
};

/*
 * These roles use a Staff identity in
 * addition to dvi_users.
 */
const STAFF_BACKED_ROLES =
  new Set<number>([
    SystemRole.STAFF,
    SystemRole.ACCOUNTS,
    SystemRole.TRAVEL_EXPERT,
    SystemRole.HOTEL_ADMIN,
  ]);

const ROLE_LABELS:
  Record<number, string> = {
  [SystemRole.VENDOR]:
    'Vendor',

  [SystemRole.STAFF]:
    'Staff',

  [SystemRole.AGENT]:
    'Agent',

  [SystemRole.GUIDE]:
    'Guide',

  [SystemRole.ACCOUNTS]:
    'Accounts',

  [SystemRole.TRAVEL_EXPERT]:
    'Travel Expert',

  [SystemRole.VEHICLE_AGENT]:
    'Vehicle Agent',

  [SystemRole.HOTEL_ADMIN]:
    'Hotel Admin',
};

@Injectable()
export class AgentConversionService {
  private readonly logger =
    new Logger(
      AgentConversionService.name,
    );

  constructor(
    private readonly prisma:
      PrismaService,
  ) {}

  private normalizeEmail(
    value: unknown,
  ): string {
    return String(value ?? '')
      .trim()
      .toLowerCase();
  }

  private getRoleLabel(
    roleId: number,
  ): string {
    return (
      ROLE_LABELS[roleId] ??
      `Role ${roleId}`
    );
  }

  async changeRole(
    agentId: number,
    targetRoleId: number,
    performedByUserId: number,
  ) {
    const roleId =
      Number(targetRoleId);

    /*
     * Admin and Agent itself are not
     * valid target roles.
     */
    if (
      !Number.isInteger(roleId) ||
      !isAgentRoleChangeTarget(
        roleId,
      )
    ) {
      throw new BadRequestException(
        'Invalid target role. Admin cannot be selected.',
      );
    }

    try {
      const result =
        await this.prisma
          .$transaction(
            async (tx) => {
              /*
               * Lock the Agent row so two
               * requests cannot change the
               * same account simultaneously.
               */
              const lockedAgents =
                await tx.$queryRaw<
                  LockedAgentRow[]
                >`
                  SELECT
                    agent_ID,
                    agent_name,
                    agent_lastname,
                    agent_email_id,
                    agent_primary_mobile_number,
                    status
                  FROM dvi_agent
                  WHERE agent_ID = ${agentId}
                    AND deleted = 0
                  LIMIT 1
                  FOR UPDATE
                `;

              const agent =
                lockedAgents[0];

              if (!agent) {
                throw new NotFoundException(
                  'Agent not found',
                );
              }

              /*
               * If this account has already
               * been changed to the requested
               * role, do not process it again.
               */
              const existingTargetUser =
                await tx.dvi_users
                  .findFirst({
                    where: {
                      agent_id:
                        agentId,

                      roleID:
                        roleId,

                      deleted: 0,
                    },

                    orderBy: {
                      userID:
                        'desc',
                    },
                  });

              if (
                existingTargetUser
              ) {
                throw new ConflictException(
                  `This Agent has already been changed to ${this.getRoleLabel(
                    roleId,
                  )}.`,
                );
              }

              /*
               * Find the actual primary
               * Agent login.
               *
               * Agent staff users may share
               * the same agent_id, therefore
               * staff_id = 0 is important.
               */
              const ownerLogins =
                await tx.dvi_users
                  .findMany({
                    where: {
                      agent_id:
                        agentId,

                      staff_id: 0,

                      roleID:
                        SystemRole.AGENT,

                      deleted: 0,
                    },

                    orderBy: {
                      userID:
                        'desc',
                    },
                  });

              if (
                !ownerLogins.length
              ) {
                throw new NotFoundException(
                  'Active Agent login not found. The account may already have been changed to another role.',
                );
              }

              const normalizedAgentEmail =
                this.normalizeEmail(
                  agent.agent_email_id,
                );

              /*
               * Prefer the owner login that
               * matches the Agent email.
               */
              const emailMatchedLogins =
                normalizedAgentEmail
                  ? ownerLogins.filter(
                      (user) =>
                        this.normalizeEmail(
                          user.useremail,
                        ) ===
                        normalizedAgentEmail,
                    )
                  : [];

              const candidates =
                emailMatchedLogins.length
                  ? emailMatchedLogins
                  : ownerLogins;

              /*
               * Do not guess between duplicate
               * Agent login records.
               */
              if (
                candidates.length !==
                1
              ) {
                throw new BadRequestException(
                  'Multiple primary Agent login records were found. Resolve the duplicate login records before changing the role.',
                );
              }

              const user =
                candidates[0];

              const normalizedLoginEmail =
                this.normalizeEmail(
                  user.useremail,
                );

              if (
                !normalizedLoginEmail
              ) {
                throw new BadRequestException(
                  'The Agent login does not have a valid email address.',
                );
              }

              /*
               * Do not allow mixed-role duplicate
               * email records because login
               * resolution could become ambiguous.
               */
              const duplicateEmailRows =
                await tx.$queryRaw<
                  Array<{
                    userID: bigint;
                  }>
                >`
                  SELECT userID
                  FROM dvi_users
                  WHERE
                    LOWER(TRIM(useremail))
                      = ${normalizedLoginEmail}
                    AND deleted = 0
                    AND userID
                      <> ${user.userID}
                `;

              if (
                duplicateEmailRows.length
              ) {
                throw new BadRequestException(
                  'Another active login already uses this email address. Resolve the duplicate login before changing this Agent role.',
                );
              }

              /*
               * Vendor authentication requires
               * vendor_id.
               *
               * Do not create a fake Vendor login
               * with vendor_id = 0.
               */
              if (
                roleId ===
                  SystemRole.VENDOR &&
                Number(
                  user.vendor_id ??
                    0,
                ) <= 0
              ) {
                throw new BadRequestException(
                  'This Agent is not linked to a Vendor profile. Create or link the Vendor profile before changing the role to Vendor.',
                );
              }

              /*
               * Guide authentication requires
               * guide_id.
               */
              if (
                roleId ===
                  SystemRole.GUIDE &&
                Number(
                  user.guide_id ??
                    0,
                ) <= 0
              ) {
                throw new BadRequestException(
                  'This Agent is not linked to a Guide profile. Create or link the Guide profile before changing the role to Guide.',
                );
              }

              const now =
                new Date();

              let staffId =
                Number(
                  user.staff_id ??
                    0,
                );

              /*
               * Staff-backed roles require a
               * valid dvi_staff_details row.
               */
              if (
                STAFF_BACKED_ROLES.has(
                  roleId,
                )
              ) {
                /*
                 * First check whether a matching
                 * Staff record already exists.
                 */
                let staff =
                  await tx
                    .dvi_staff_details
                    .findFirst({
                      where: {
                        agent_id:
                          agentId,

                        roleID:
                          roleId,

                        staff_email:
                          user.useremail ??
                          agent.agent_email_id ??
                          '',

                        deleted: 0,
                      },

                      orderBy: {
                        staff_id:
                          'desc',
                      },
                    });

                if (!staff) {
                  const staffName =
                    [
                      agent.agent_name,
                      agent.agent_lastname,
                    ]
                      .filter(Boolean)
                      .join(' ')
                      .trim() ||
                    `Agent ${agentId}`;

                  staff =
                    await tx
                      .dvi_staff_details
                      .create({
                        data: {
                          agent_id:
                            agentId,

                          staff_name:
                            staffName,

                          staff_mobile:
                            agent.agent_primary_mobile_number ??
                            '',

                          staff_email:
                            user.useremail ??
                            agent.agent_email_id ??
                            '',

                          roleID:
                            roleId,

                          status:
                            Number(
                              user.status ??
                                1,
                            ),

                          deleted: 0,

                          createdby:
                            performedByUserId ||
                            1,

                          createdon:
                            now as any,
                        },
                      });
                }

                staffId =
                  Number(
                    staff.staff_id,
                  );
              }

              /*
               * Update the SAME dvi_users
               * login.
               *
               * We deliberately preserve:
               *
               * - userID
               * - useremail
               * - password
               * - agent_id
               * - userapproved
               * - userbanned
               */
              await tx.dvi_users
                .update({
                  where: {
                    userID:
                      user.userID,
                  },

                  data: {
                    agent_id:
                      agentId,

                    roleID:
                      roleId,

                    /*
                     * Staff-backed roles get the
                     * new staff identity.
                     *
                     * Other roles keep the
                     * existing value.
                     */
                    staff_id:
                      STAFF_BACKED_ROLES.has(
                        roleId,
                      )
                        ? staffId
                        : Number(
                            user.staff_id ??
                              0,
                          ),

                    updatedon:
                      now as any,
                  },
                });

              return {
                success: true,

                message:
                  `Agent successfully changed to ${this.getRoleLabel(
                    roleId,
                  )}.`,

                agentId,

                userId:
                  Number(
                    user.userID,
                  ),

                roleID:
                  roleId,

                roleName:
                  this.getRoleLabel(
                    roleId,
                  ),

                staffId:
                  staffId || null,

                requiresReLogin:
                  true,
              };
            },
          );

      this.logger.log(
        [
          'Changed Agent role',
          `agentId=${result.agentId}`,
          `userId=${result.userId}`,
          `role=${result.roleID}`,
          `roleName=${result.roleName}`,
          `staffId=${result.staffId ?? 0}`,
          `performedBy=${performedByUserId}`,
        ].join(' | '),
      );

      return result;
    } catch (error) {
      if (
        error instanceof
        HttpException
      ) {
        throw error;
      }

      this.logger.error(
        `Agent ${agentId} role change failed`,
        error instanceof Error
          ? error.stack
          : String(error),
      );

      throw new BadRequestException(
        'Agent role change failed. No changes were saved.',
      );
    }
  }

  /*
   * Keep the old method available so any
   * existing caller using the old endpoint
   * does not suddenly break.
   */
  async convertToTravelExpert(
    agentId: number,
    performedByUserId: number,
  ) {
    return this.changeRole(
      agentId,
      SystemRole.TRAVEL_EXPERT,
      performedByUserId,
    );
  }
}