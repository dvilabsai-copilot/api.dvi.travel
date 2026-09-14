import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CalendarEventsQueryDto } from './dto/calendar-events-query.dto';
import { CalendarEventsService } from './calendar-events.service';
import { CreateCalendarEventDto } from './dto/create-calendar-event.dto';
import { UpdateCalendarEventDto } from './dto/update-calendar-event.dto';

@ApiTags('Calendar Events')
@ApiBearerAuth()
@Controller('calendar-events')
export class CalendarEventsController {
  constructor(private readonly service: CalendarEventsService) {}

  @Get('admin')
  @ApiOperation({ summary: 'List holidays and festivals for Settings administration' })
  listAdmin() {
    return this.service.listAdmin();
  }

  @Post()
  @ApiOperation({ summary: 'Create a holiday or festival' })
  create(@Body() dto: CreateCalendarEventDto, @Req() req: any) {
    return this.service.create(dto, Number(req?.user?.id ?? 0) || 0);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a holiday or festival' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCalendarEventDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Activate or deactivate a holiday or festival' })
  updateStatus(@Param('id', ParseIntPipe) id: number, @Body('status') status: number) {
    return this.service.updateStatus(id, status);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a holiday or festival' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.service.remove(id);
    return { success: true };
  }

  @Get()
  @ApiOperation({ summary: 'Read advisory holidays and festivals for a date range' })
  @ApiQuery({ name: 'from', required: true, type: String, example: '2026-10-01' })
  @ApiQuery({ name: 'to', required: true, type: String, example: '2026-11-30' })
  @ApiQuery({ name: 'location', required: false, type: String, isArray: true, description: 'Repeat for each itinerary location name' })
  @ApiResponse({ status: 200, description: 'Calendar events with location resolution metadata' })
  getEvents(@Query() query: CalendarEventsQueryDto) {
    return this.service.getEvents(query);
  }
}
