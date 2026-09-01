import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';

import { PrismaService } from '../../prisma.service';
import {
  ItineraryAccessService,
  type ItineraryViewer,
} from '../itineraries/services/itinerary-access.service';

import {
  SystemRole,
} from '../auth/constants/system-role.constants';
import { CreatePublicItineraryLinkDto } from './dto/create-public-itinerary-link.dto';

type PublicLinkViewer = ItineraryViewer & {
  userID?: number;
  userId?: number;
  roleID?: number;
  roleId?: number;
  agentId?: number;
  agent_id?: number;
};
@Injectable()
export class PublicItineraryLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly itineraryAccessService: ItineraryAccessService,
  ) {}

  private getConfiguration() {
    const ttlHours = Number(
      process.env.PUBLIC_ITINERARY_LINK_TTL_HOURS ?? 72,
    );

    const tokenBytes = Number(
      process.env.PUBLIC_ITINERARY_LINK_TOKEN_BYTES ?? 32,
    );

    const baseUrl = String(
      process.env.PUBLIC_ITINERARY_BASE_URL ?? '',
    )
      .trim()
      .replace(/\/+$/, '');

    const frontendPath =
      '/' +
      String(
        process.env.PUBLIC_ITINERARY_FRONTEND_PATH ??
          '/view-itinerary',
      )
        .trim()
        .replace(/^\/+|\/+$/g, '');

    if (
      !Number.isInteger(ttlHours) ||
      ttlHours <= 0 ||
      !Number.isInteger(tokenBytes) ||
      tokenBytes < 32 ||
      !baseUrl
    ) {
      throw new InternalServerErrorException(
        'Public itinerary link configuration is invalid',
      );
    }

    return {
      ttlHours,
      tokenBytes,
      baseUrl,
      frontendPath,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256')
      .update(token)
      .digest('hex');
  }

  async createPublicLink(
    dto: CreatePublicItineraryLinkDto,
    viewer?: ItineraryViewer,
  ) {
 const itineraryPlanId = Number(dto.itineraryPlanId);

const groupType = Number(dto.groupType);

const authenticatedViewer =
  viewer as PublicLinkViewer | undefined;

const createdByUserId =
  Number(
    authenticatedViewer?.userID ??
      authenticatedViewer?.userId ??
      0,
  ) || null;

const viewerRoleId = Number(
  authenticatedViewer?.roleID ??
    authenticatedViewer?.roleId ??
    0,
);

const access =
  await this.itineraryAccessService.getPlanAccessDecision(
    itineraryPlanId,
    viewer,
  );
    if (!access.exists) {
      throw new NotFoundException(
        'Itinerary plan not found',
      );
    }

    if (!access.allowed) {
      throw new ForbiddenException(
        'You are not allowed to share this itinerary',
      );
    }

    const plan =
      await this.prisma.dvi_itinerary_plan_details.findFirst({
        where: {
          itinerary_plan_ID: itineraryPlanId,
          deleted: 0,
        },
      select: {
  itinerary_plan_ID: true,
  agent_id: true,
},
      });

    if (!plan) {
  throw new NotFoundException(
    'Active itinerary plan not found',
  );
}

const planAgentId =
  Number(plan.agent_id || 0);

const createdByAgentId =
  viewerRoleId === SystemRole.AGENT &&
  planAgentId > 0
    ? planAgentId
    : null;

    const cancelledItinerary =
      await this.prisma.dvi_cancelled_itineraries.findFirst({
        where: {
          itinerary_plan_id: itineraryPlanId,
          deleted: 0,
        },
        select: {
          cancelled_itinerary_ID: true,
        },
      });

    if (cancelledItinerary) {
      throw new BadRequestException(
        'Cancelled itinerary cannot be shared',
      );
    }

    const {
      ttlHours,
      tokenBytes,
      baseUrl,
      frontendPath,
    } = this.getConfiguration();

    const rawToken =
      randomBytes(tokenBytes).toString('base64url');

    const tokenHash = this.hashToken(rawToken);

    const expiresAt = new Date(
      Date.now() + ttlHours * 60 * 60 * 1000,
    );

    await this.prisma.public_itinerary_links.create({
  data: {
    tokenHash,
    itineraryPlanId,
    groupType,
    expiresAt,
    createdByUserId,
    createdByAgentId,
  },
});

    return {
      url: `${baseUrl}${frontendPath}/${rawToken}`,
      expiresAt: expiresAt.toISOString(),
    };
  }
}