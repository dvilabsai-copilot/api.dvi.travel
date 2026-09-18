// FILE: src/modules/agent/agent.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import {
  FileFieldsInterceptor,
} from '@nestjs/platform-express';

import { diskStorage } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AgentService } from './agent.service';
import { ListAgentQueryDto } from './dto/list-agent.dto';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { UpdateAgentConfigDto } from './dto/update-agent-config.dto';
import { UpdateAgentSelfProfileDto } from './dto/update-agent-self-profile.dto';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';

function agentGalleryStorage() {
  return diskStorage({
    destination: (_req, _file, callback) => {
      const directory = path.join(
        process.cwd(),
        'public',
        'uploads',
        'agent_gallery',
      );

      fs.mkdirSync(directory, {
        recursive: true,
      });

      callback(null, directory);
    },

    filename: (_req, file, callback) => {
      const extension =
        path.extname(
          file.originalname,
        ).toLowerCase();

      const filename =
        `${Date.now()}-${randomBytes(6).toString('hex')}${extension}`;

      callback(null, filename);
    },
  });
}

function agentImageFilter(
  _req: any,
  file: Express.Multer.File,
  callback: any,
) {
  const allowedMimeTypes = [
    'image/jpeg',
    'image/png',
  ];

  if (
    !allowedMimeTypes.includes(
      file.mimetype,
    )
  ) {
    return callback(
      new BadRequestException(
        'Only JPG, JPEG and PNG images are allowed',
      ),
      false,
    );
  }

  callback(null, true);
}

@ApiTags('agents')
@ApiBearerAuth()
@Controller('agents')
export class AgentController {
  constructor(private readonly service: AgentService) {}

@UseGuards(JwtAuthGuard)
@Get('profile')
getProfile(@Req() req: any) {
  const user = req.user;

  // Role 4 is Agent
  if (Number(user.role) === 4) {
    return this.service.getProfile(
      Number(user.agentId),
    );
  }

  throw new UnauthorizedException(
    'Only agents can access this profile',
  );
}

@UseGuards(JwtAuthGuard)
@Put('profile')
@UseInterceptors(
  FileFieldsInterceptor(
    [
      {
        name: 'siteLogo',
        maxCount: 1,
      },
      {
        name: 'invoiceLogo',
        maxCount: 1,
      },
    ],
    {
      storage: agentGalleryStorage(),
      fileFilter: agentImageFilter,
      limits: {
        fileSize:
          5 * 1024 * 1024,
      },
    },
  ),
)
updateOwnProfile(
  @Req() req: any,
  @Body()
  body: UpdateAgentSelfProfileDto,
  @UploadedFiles()
  files: {
    siteLogo?: Express.Multer.File[];
    invoiceLogo?: Express.Multer.File[];
  },
) {
  const user = req.user;

  if (
    Number(user.role) !== 4 ||
    !Number(user.agentId)
  ) {
    throw new ForbiddenException(
      'Only agents can update their own profile',
    );
  }

  return this.service.updateSelfProfile(
    Number(user.agentId),
    body,
    {
      siteLogo:
        files?.siteLogo?.[0]
          ?.filename ?? null,

      invoiceLogo:
        files?.invoiceLogo?.[0]
          ?.filename ?? null,
    },
  );
}

 /**
   * Lightweight list: [{ id, name }]
   * Useful for dropdowns or quick client-side enrichment.
   * Path order matters—keep this ABOVE ':id'.
 */
  @Get('names')
  listNames() {
    return this.service.listNames();
  }
 /** Full list with all fields (existing) */
  @Get('full')
  fullList(@Query() query: ListAgentQueryDto) {
    return this.service.listFull(query);
  }

 /** Paginated/DT list with rich fields (existing) */
  @UseGuards(JwtAuthGuard)
  @Get()
  async list(@Req() req: any, @Query() query: ListAgentQueryDto) {
    const user = req.user;
 // Role 3 or 8 is Travel Expert / Staff
    if ((user.role === 3 || user.role === 8 || (user.staffId && user.staffId > 0)) && user.role !== 4 && user.role !== 6) {
      query.travelExpertId = Number(user.staffId);
    }
    return this.service.list(query);
  }

 @UseGuards(JwtAuthGuard)
@Get('travel-experts')
async listTravelExperts(
  @Req() req: any,
) {
  const role = Number(
    req.user?.roleID ??
      req.user?.role ??
      0,
  );

  if (role !== 1) {
    throw new ForbiddenException(
      'Only Admin can assign Travel Experts',
    );
  }

  return this.service
    .listTravelExperts();
}

/** Preview / read one */
@Get(':id')
preview(
  @Param('id', ParseIntPipe)
  id: number,
) {
    return this.service.getById(id);
  }

 /** Edit prefill (same as preview for now) */
  @Get(':id/edit')
  prefill(@Param('id', ParseIntPipe) id: number) {
    return this.service.getEditPrefill(id);
  }

 /**
   * Subscription history for an agent.
   * Reads rows from dvi_agent_subscribed_plans (or synthesizes “Free / 365 Days”).
 */
  @Get(':id/subscriptions')
  subscriptions(@Param('id', ParseIntPipe) id: number) {
    return this.service.getSubscriptions(id);
  }

 /** Agent configuration */
@Get(':id/config')
getConfig(@Param('id', ParseIntPipe) id: number) {
  return this.service.getConfig(id);
}

/** Update agent configuration and margin settings. */
@UseGuards(JwtAuthGuard)
@Put(':id/config')
updateConfig(
  @Param('id', ParseIntPipe) id: number,
  @Body() body: UpdateAgentConfigDto,
) {
  return this.service.updateConfig(id, body);
}

/** Cash wallet history */
@Get(':id/wallet/cash')
getCashWalletHistory(@Param('id', ParseIntPipe) id: number) {
  return this.service.getCashWalletHistory(id);
}

/** Coupon wallet history */
@Get(':id/wallet/coupon')
getCouponWalletHistory(@Param('id', ParseIntPipe) id: number) {
  return this.service.getCouponWalletHistory(id);
}

/** Add cash wallet */
@Post(':id/wallet/cash')
addCashWallet(
  @Param('id', ParseIntPipe) id: number,
  @Body() body: { amount: number; remark: string },
  @Req() req: any,
) {
  return this.service.addCashWallet(id, body, req.user);
}

/** Add coupon wallet */
@Post(':id/wallet/coupon')
addCouponWallet(
  @Param('id', ParseIntPipe) id: number,
  @Body() body: { amount: number; remark: string },
) {
  return this.service.addCouponWallet(id, body);
}

/** Create */
@Post()
create(@Body() body: CreateAgentDto) {
  return this.service.create(body);
}

 @UseGuards(JwtAuthGuard)
@Put(':id/travel-expert')
assignTravelExpert(
  @Req() req: any,
  @Param(
    'id',
    ParseIntPipe,
  )
  id: number,
  @Body()
  body: {
    travelExpertId: number;
  },
) {
  const role = Number(
    req.user?.roleID ??
      req.user?.role ??
      0,
  );

  if (role !== 1) {
    throw new ForbiddenException(
      'Only Admin can assign Travel Experts',
    );
  }

  const travelExpertId =
    Number(
      body.travelExpertId ??
        0,
    );

  if (
    !Number.isFinite(
      travelExpertId,
    ) ||
    travelExpertId < 0
  ) {
    throw new BadRequestException(
      'Invalid Travel Expert',
    );
  }

  return this.service
    .assignTravelExpert(
      id,
      travelExpertId,
    );
}

/** Update */
@Put(':id')
update(
  @Param('id', ParseIntPipe)
  id: number,
  @Body()
  body: UpdateAgentDto,
) {
  return this.service.update(
    id,
    body,
  );
}

 /** Soft delete */
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.softDelete(id);
  }

  /** Toggle agent account login (enable/disable) */
  @Put(':id/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable or disable agent account login' })
  async toggleLogin(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { enable: boolean },
  ) {
    return this.service.toggleLogin(id, body.enable);
  }
}
