// FILE: src/modules/agent/agent.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
  Req,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AgentService } from './agent.service';
import { ListAgentQueryDto } from './dto/list-agent.dto';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';

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
    if (user.role === 4) {
      return this.service.getById(Number(user.agentId));
    }
    throw new UnauthorizedException('Only agents can access this profile');
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

 /** Preview / read one */
  @Get(':id')
  preview(@Param('id', ParseIntPipe) id: number) {
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
) {
  return this.service.addCashWallet(id, body);
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

 /** Update */
  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: UpdateAgentDto) {
    return this.service.update(id, body);
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
