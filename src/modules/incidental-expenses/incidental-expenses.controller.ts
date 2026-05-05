import { Controller, Get, Post, Body, Query, Delete, Param, BadRequestException } from '@nestjs/common';
import { IncidentalExpensesService } from './incidental-expenses.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Incidental Expenses')
@Controller('incidental-expenses')
export class IncidentalExpensesController {
  constructor(private readonly incidentalExpensesService: IncidentalExpensesService) {}

  private parsePositiveInt(value: string, fieldName: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      throw new BadRequestException(`${fieldName} must be a positive integer`);
    }
    return parsed;
  }

  @Get('available-components')
  @ApiOperation({ summary: 'Get available components for incidental expenses' })
  getAvailableComponents(@Query('itineraryPlanId') itineraryPlanId: string) {
    const planId = this.parsePositiveInt(itineraryPlanId, 'itineraryPlanId');
    return this.incidentalExpensesService.getAvailableComponents(planId);
  }

  @Get('available-margin')
  @ApiOperation({ summary: 'Get available margin for a component' })
  getAvailableMargin(
    @Query('itineraryPlanId') itineraryPlanId: string,
    @Query('componentType') componentType: string,
    @Query('componentId') componentId?: string,
  ) {
    const planId = this.parsePositiveInt(itineraryPlanId, 'itineraryPlanId');
    const parsedComponentType = this.parsePositiveInt(componentType, 'componentType');
    if (parsedComponentType < 1 || parsedComponentType > 5) {
      throw new BadRequestException('componentType must be between 1 and 5');
    }

    return this.incidentalExpensesService.getAvailableMargin(
      planId,
      parsedComponentType,
      componentId ? this.parsePositiveInt(componentId, 'componentId') : undefined,
    );
  }

  @Post()
  @ApiOperation({ summary: 'Add incidental expense' })
  addIncidentalExpense(@Body() data: {
    itineraryPlanId: number;
    componentType: number;
    componentId: number;
    amount: number;
    reason: string;
    createdBy: number;
  }) {
    return this.incidentalExpensesService.addIncidentalExpense(data);
  }

  @Get('history')
  @ApiOperation({ summary: 'Get incidental expenses history' })
  getHistory(@Query('itineraryPlanId') itineraryPlanId: string) {
    const planId = this.parsePositiveInt(itineraryPlanId, 'itineraryPlanId');
    return this.incidentalExpensesService.getIncidentalHistory(planId);
  }

  @Delete('history/:id')
  @ApiOperation({ summary: 'Delete incidental expense history' })
  deleteHistory(@Param('id') id: string) {
    return this.incidentalExpensesService.deleteIncidentalHistory(Number(id));
  }
}
