import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/public.decorator';
import { ImpersonationService } from './impersonation.service';
import { RedeemImpersonationDto, ResolveImpersonationDto, StartImpersonationDto } from './dto/impersonation.dto';

@ApiTags('auth-impersonation')
@Controller('auth/impersonation')
export class ImpersonationController {
  constructor(private readonly service: ImpersonationService) {}

  @Post('resolve')
  resolve(@Req() req: any, @Body() body: ResolveImpersonationDto) {
    return this.service.resolve(req.user, body.entityType, body.entityId, body.targetUserId, body.targetEmail);
  }

  @Post('start')
  start(@Req() req: any, @Body() body: StartImpersonationDto) {
    return this.service.start(req.user, body.targetUserId, body.reason);
  }

  @Public()
  @Post('redeem')
  redeem(@Body() body: RedeemImpersonationDto, @Res({ passthrough: true }) response: any) {
    return this.service.redeem(body.ticket, response);
  }

  @Get('current')
  current(@Req() req: any) {
    return this.service.current(req.user);
  }

  @Post('end')
  end(@Req() req: any, @Res({ passthrough: true }) response: any) {
    return this.service.end(req.user, response);
  }

  @Get('history')
  history(@Req() req: any, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.service.history(req.user, Number(page || 1), Number(pageSize || 25));
  }
}
