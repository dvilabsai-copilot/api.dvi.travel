import {
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { SystemRole, getRoleId } from '../auth/constants/system-role.constants';
import { AgentDashboardAdsService } from './agent-dashboard-ads.service';
import { SaveAgentDashboardAdDto, SetAgentDashboardAdEnabledDto } from './dto/agent-dashboard-ad.dto';

/** Server-enforced authorization. Frontend hiding controls is not sufficient. */
@Injectable()
export class AgentDashboardAdsAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest()?.user;
    if (getRoleId(user) !== SystemRole.ADMIN || user?.isImpersonating) {
      throw new ForbiddenException('Only Super Admin can manage advertisements');
    }
    return true;
  }
}

@ApiTags('agent-dashboard-ads')
@ApiBearerAuth()
@Controller('agent-dashboard-ads')
export class AgentDashboardAdsController {
  constructor(private readonly service: AgentDashboardAdsService) {}

  /** Authenticated Agents receive published ads only; admins can preview them. */
  @Get('active')
  active(@Req() req: { user?: unknown }) {
    const role = getRoleId(req.user);
    if (role !== SystemRole.AGENT && role !== SystemRole.ADMIN) {
      throw new ForbiddenException('Agent dashboard access required');
    }
    return this.service.active();
  }

  @Get()
  @UseGuards(AgentDashboardAdsAdminGuard)
  list() {
    return this.service.list();
  }

  @Post('upload')
  @UseGuards(AgentDashboardAdsAdminGuard)
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
  }))
  upload(@UploadedFile() file?: Express.Multer.File) {
    return this.service.upload(file);
  }

  @Post()
  @UseGuards(AgentDashboardAdsAdminGuard)
  create(@Body() dto: SaveAgentDashboardAdDto) {
    return this.service.create(dto);
  }

  @Put(':id')
  @UseGuards(AgentDashboardAdsAdminGuard)
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: SaveAgentDashboardAdDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/enabled')
  @UseGuards(AgentDashboardAdsAdminGuard)
  setEnabled(@Param('id', ParseIntPipe) id: number, @Body() dto: SetAgentDashboardAdEnabledDto) {
    return this.service.setEnabled(id, dto.enabled);
  }

  @Delete(':id')
  @UseGuards(AgentDashboardAdsAdminGuard)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
