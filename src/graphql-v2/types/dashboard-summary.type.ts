import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class DashboardStatsV2Type {
  @Field(() => Int)
  totalAgents: number;

  @Field(() => Int)
  totalDrivers: number;

  @Field(() => Int)
  totalItineraries: number;

  @Field(() => Int)
  confirmedBookings: number;

  @Field(() => Float)
  totalRevenue: number;
}

@ObjectType()
export class DashboardProfitV2Type {
  @Field(() => Float)
  currentMonth: number;

  @Field(() => Float)
  lastMonth: number;

  @Field(() => Float)
  percentageChange: number;
}

@ObjectType()
export class DashboardVehiclesV2Type {
  @Field(() => Int)
  total: number;

  @Field(() => Int)
  available: number;

  @Field(() => Int)
  onRoute: number;

  @Field(() => Int)
  upcoming: number;
}

@ObjectType()
export class DashboardVendorsV2Type {
  @Field(() => Int)
  total: number;

  @Field(() => Int)
  branches: number;

  @Field(() => Int)
  inactive: number;
}

@ObjectType()
export class DashboardDriversV2Type {
  @Field(() => Int)
  total: number;

  @Field(() => Int)
  active: number;

  @Field(() => Int)
  inactive: number;

  @Field(() => Int)
  onRoute: number;

  @Field(() => Int)
  available: number;
}

@ObjectType()
export class DashboardHotelsV2Type {
  @Field(() => Int)
  total: number;

  @Field(() => Int)
  rooms: number;

  @Field(() => Int)
  amenities: number;

  @Field(() => Int)
  bookings: number;
}

@ObjectType()
export class DashboardDailyMomentV2Type {
  @Field({ nullable: true })
  quoteId?: string;

  @Field({ nullable: true })
  location?: string;
}

@ObjectType()
export class DashboardStarPerformerV2Type {
  @Field({ nullable: true })
  name?: string;

  @Field({ nullable: true })
  phone?: string;

  @Field(() => Float, { nullable: true })
  performance?: number;
}

@ObjectType()
export class DashboardSummaryV2Type {
  @Field(() => DashboardStatsV2Type)
  stats: DashboardStatsV2Type;

  @Field(() => DashboardProfitV2Type)
  profit: DashboardProfitV2Type;

  @Field(() => DashboardVehiclesV2Type)
  vehicles: DashboardVehiclesV2Type;

  @Field(() => DashboardVendorsV2Type)
  vendors: DashboardVendorsV2Type;

  @Field(() => DashboardDriversV2Type)
  drivers: DashboardDriversV2Type;

  @Field(() => DashboardHotelsV2Type)
  hotels: DashboardHotelsV2Type;

  @Field(() => DashboardDailyMomentV2Type, { nullable: true })
  dailyMoment?: DashboardDailyMomentV2Type;

  @Field(() => DashboardStarPerformerV2Type, { nullable: true })
  starPerformer?: DashboardStarPerformerV2Type;
}
