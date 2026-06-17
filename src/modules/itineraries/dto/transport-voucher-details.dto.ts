export interface TransportVoucherDetails {
  voucher: {
    voucherNo: string;
    date: string;
    title: string;
    dateRange: string;
  };
  company: {
    name: string;
    tagline: string;
    phone: string;
    email: string;
    website: string;
    logoPath?: string;
    qrText?: string;
  };
  guest: {
    name: string;
    pax: string;
    contactNo: string;
    email: string;
    pickupLocation: string;
    dropLocation: string;
  };
  trip: {
    tourType: string;
    travelRegion: string;
    checkInDate: string;
    checkOutDate: string;
    duration: string;
  };
  flight: {
    arrival: {
      airline: string;
      flightNo: string;
      from: string;
      to: string;
      date: string;
      time: string;
      rawText?: string;
    };
    departure: {
      airline: string;
      flightNo: string;
      from: string;
      to: string;
      date: string;
      time: string;
      rawText?: string;
    };
  };
  vehicle: {
    type: string;
    vehicleNo: string;
    seatingCapacity: string;
    ac: string;
    luggageSpace: string;
    insurance: string;
    imagePath?: string;
  };
  vehicles: Array<{
    type: string;
    vehicleNo: string;
    seatingCapacity: string;
    ac: string;
    luggageSpace: string;
    insurance: string;
    imagePath?: string;
    vendorName?: string;
    origin?: string;
    qty?: number;
    amount?: string;
    confirmedBy?: string;
    confirmedMobile?: string;
    confirmedEmail?: string;
  }>;
  days: Array<{
    dayNo: number;
    date: string;
    weekday: string;
    routeAndPlaces: string;
    travelRoute: string;
    startTime: string;
    endTime: string;
  }>;
  footer: {
    inclusions: string[];
    notes: string[];
    emergencyPhone: string;
    emergencyEmail: string;
  };
}
