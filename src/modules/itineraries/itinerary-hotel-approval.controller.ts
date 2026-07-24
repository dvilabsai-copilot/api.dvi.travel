import { Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ItineraryHotelApprovalService } from './services/itinerary-hotel-approval.service';

@ApiTags('Itinerary hotel approval')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('itineraries/hotels')
export class ItineraryHotelApprovalController {
  constructor(private readonly approvalService: ItineraryHotelApprovalService) {}

  @Get('pending-approval')
  @ApiOperation({ summary: 'List offline hotel selections pending approval' })
  listPendingApproval(@Req() request: Request) {
    this.assertApprovalActor(request);
    return this.approvalService.listPendingApproval();
  }

  @Post(':selectionId/approve')
  @ApiOperation({ summary: 'Approve an offline hotel selection' })
  approve(@Param('selectionId') selectionId: string, @Body() body: { notes?: string; approvedPrice?: number }, @Req() request: Request) {
    this.assertApprovalActor(request);
    return this.approvalService.approve(Number(selectionId), this.getActorId(request), body?.notes, body?.approvedPrice);
  }

  @Post(':selectionId/reject')
  @ApiOperation({ summary: 'Reject an offline hotel selection' })
  reject(@Param('selectionId') selectionId: string, @Body() body: { notes?: string }, @Req() request: Request) {
    this.assertApprovalActor(request);
    return this.approvalService.reject(Number(selectionId), this.getActorId(request), body?.notes);
  }

  @Post(':selectionId/confirm-manually')
  @ApiOperation({ summary: 'Record manual hotel booking confirmation' })
  confirmManually(@Param('selectionId') selectionId: string, @Body() body: { notes?: string }, @Req() request: Request) {
    this.assertApprovalActor(request);
    return this.approvalService.confirmManually(Number(selectionId), this.getActorId(request), body?.notes);
  }

  private getActorId(request: Request): number {
    const actorId = Number((request as any)?.user?.userId || 0);
    if (!Number.isInteger(actorId) || actorId <= 0) {
      throw new ForbiddenException('A valid authenticated approval actor is required.');
    }
    return actorId;
  }

  private assertApprovalActor(request: Request): void {
    const user = (request as any)?.user;
    const role = Number(user?.role ?? user?.roleID ?? 0);
    if (![1, 3, 8].includes(role)) {
      throw new ForbiddenException('Only Admin and Staff users can manage hotel approvals.');
    }
  }
}
