import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RolesGuard } from './auth/roles.guard';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PrismaModule } from './prisma.module';
import { UsersModule } from './modules/users/users.module';
import { HotelsModule } from './modules/hotels/hotels.module';
import { AuthModule } from './modules/auth/auth.module';
import {AccountsManagerModule} from './modules/accounts-manager/accounts-manager.module';
import { AccountsLedgerModule } from './modules/accounts-ledger/accounts-ledger.module';
import { ItinerariesModule } from './modules/itineraries/itinerary.module';
import {ItineraryDropdownsModule  } from './modules/itinerary-dropdowns/itinerary-dropdowns.module';
import { DailyMomentTrackerModule } from './modules/daily-moment-tracker/daily-moment-tracker.module';
import { AgentsModule } from './modules/agents/agents.module';
import {ItineraryViaRoutesModule} from './modules/itinerary-via-routes/itinerary-via-routes.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { DriversModule } from './modules/drivers/drivers.module';
import { VehicleAvailabilityModule } from './modules/vehicle-availability/vehicle-availability.module';
import { HotspotsModule } from './modules/hotspots/hotspots.module';
import { HotspotDistanceCacheModule } from './modules/hotspot-distance-cache/hotspot-distance-cache.module';
import { ActivitiesModule } from './modules/activities/activities.module';
import { LocationsModule } from './modules/locations/locations.module';
import { GuidesModule } from './modules/guides/guides.module';
import { StaffModule } from './modules/staff/staff.module';
import { AgentModule } from './modules/agent/agent.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { GstSettingsModule } from './modules/settings/gst-settings/gst-settings.module';
import { ExportPricebookModule } from './modules/export-pricebook/export-pricebook.module';
import { InbuiltAmenitiesModule } from "./modules/settings/inbuilt-amenities/inbuilt-amenities.module";
import { VehicleTypesModule } from './modules/settings/vehicle-types/vehicle-types.module';
import { CitiesModule } from './modules/settings/cities/cities.module';
import { LanguageModule } from './modules/settings/language/language.module';
import { RolePermissionModule } from './modules/settings/role-permission/role-permission.module';
import { AgentSubscriptionPlanModule } from './modules/settings/agent-subscription-plan/agent-subscription-plan.module';
import { HotelCategoryModule } from './modules/settings/hotel-category/hotel-category.module';
import { GlobalSettingsModule } from './modules/settings/global-settings/global-settings.module';
import { IncidentalExpensesModule } from './modules/incidental-expenses/incidental-expenses.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { AccountsExportModule } from './modules/accounts-export/accounts-export.module';
import { AxisRoomsModule } from './modules/axisrooms/axisrooms.module';
import { StaahModule } from './modules/staah/staah.module';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule,VendorsModule,AgentsModule,ItineraryViaRoutesModule,HotelsModule,DailyMomentTrackerModule, ItineraryDropdownsModule, ItinerariesModule,AccountsManagerModule, AccountsLedgerModule, DriversModule, VehicleAvailabilityModule, HotspotsModule, HotspotDistanceCacheModule, ActivitiesModule, LocationsModule, GuidesModule, StaffModule, AgentModule, DashboardModule, GstSettingsModule,InbuiltAmenitiesModule, VehicleTypesModule, CitiesModule, ExportPricebookModule, IncidentalExpensesModule, PaymentsModule, LanguageModule, RolePermissionModule, AgentSubscriptionPlanModule, HotelCategoryModule, GlobalSettingsModule, AccountsExportModule, AxisRoomsModule, StaahModule],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
