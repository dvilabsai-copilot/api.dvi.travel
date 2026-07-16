import { Injectable } from '@nestjs/common';

export interface HotelCheckInProjection {
  hotelName: string;
  segment: {
    type: 'checkin';
    hotelName: string;
    hotelAddress: string;
    time: string | null;
  };
}

@Injectable()
export class ItineraryDetailsHotelCheckInService {
  build(context: {
    hotelInfo: any;
    isVehicleOnly: boolean;
    location: any;
    route: any;
    hotelArrivalTime: string | null;
    endTimeText: string | null;
    startTimeText: string | null;
    formatTime: (value: any) => string;
  }): HotelCheckInProjection {
    const {
      hotelInfo,
      isVehicleOnly,
      location,
      route,
      hotelArrivalTime,
      endTimeText,
      startTimeText,
      formatTime,
    } = context;
    const hotelName = isVehicleOnly
      ? 'Hotel'
      : (
        hotelInfo?.hotel_name ??
        hotelInfo?.hotel_city ??
        location?.destination_location ??
        route.next_visiting_location ??
        'Hotel'
      );
    const checkInTime =
      hotelArrivalTime ??
      endTimeText ??
      startTimeText ??
      formatTime(route.route_end_time as any) ??
      null;

    return {
      hotelName,
      segment: {
        type: 'checkin',
        hotelName,
        hotelAddress: hotelInfo?.hotel_address ?? '',
        time: checkInTime,
      },
    };
  }
}
