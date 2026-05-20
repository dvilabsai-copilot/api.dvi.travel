/**
 * SAMPLE PAYLOADS - TBO Hotel Supplement Handling
 * 
 * These are real examples showing how supplements flow through the system.
 * Use these for testing, debugging, and understanding the data structure.
 */

// ============================================================================
// 1. TBO SEARCH API RESPONSE (Raw from TBO's /Search endpoint)
// ============================================================================

const tboSearchRawResponse = {
  "Status": {
    "Code": 200,
    "Description": "Successful"
  },
  "HotelResult": [
    {
      "HotelCode": "1347149",
      "HotelName": "Pearl Delta Dubai", // Will be overridden by DB lookup
      "Currency": "INR",
      "Rooms": [
        {
          "Name": [
            "Standard King Room,1 King Bed,NonSmoking"
          ],
          "BookingCode": "1347149!TB!3!TB!e0ed6d7e-2426-11f1-aada-ba9013e35c3f!TB!N!TB!AFF!",
          "Inclusion": "Free breakfast,Free self parking",
          "DayRates": [
            [
              {
                "BasePrice": 3723.07
              }
            ]
          ],
          "TotalFare": 4567.22,
          "TotalTax": 844.16,
          "RoomPromotion": [
            "Save:10%"
          ],
          "CancelPolicies": [
            {
              "FromDate": "19-03-2026 00:00:00",
              "ChargeType": "Fixed",
              "CancellationCharge": 0
            },
            {
              "FromDate": "01-05-2026 00:00:00",
              "ChargeType": "Percentage",
              "CancellationCharge": 100
            }
          ],
          "MealType": "BreakFast",
          "IsRefundable": true,
          // ✅ NEW (In live TBO responses): Supplements array
          "Supplements": [
            {
              "Type": "AtProperty",
              "Description": "mandatory_tax",
              "Price": 10,
              "Currency": "AED",
              "ChargeType": "Fixed"
            },
            {
              "Type": "AtProperty",
              "Description": "Local City Tax",
              "Price": 2.5,
              "Currency": "AED"
            }
          ],
          "WithTransfers": false
        }
      ]
    }
  ]
};

// ============================================================================
// 2. BACKEND NORMALIZED SEARCH RESULT
// Our normalized format after TBOHotelProvider processing
// ============================================================================

const backendNormalizedSearchResult = {
  "provider": "tbo",
  "hotelCode": "1347149",
  "hotelName": "Pearl Delta Dubai", // From DB, after lookup
  "cityCode": "DXB",
  "address": "Sheikh Zayed Road, Dubai",
  "rating": 4,
  "category": "4-Star",
  "facilities": ["Free breakfast", "Free self parking"],
  "images": [],
  "price": 4567.22,
  "currency": "INR",
  "roomType": "Standard King Room",
  "mealPlan": "Breakfast Included",
  "roomTypes": [
    {
      "roomCode": "1347149!TB!3!TB!e0ed6d7e-2426-11f1-aada-ba9013e35c3f!TB!N!TB!AFF!",
      "roomName": "Standard King Room",
      "bedType": "King",
      "capacity": 2,
      "price": 4567.22,
      "cancellationPolicy": "Non-refundable after 01-05-2026",
      // ✅ NEW: Supplements included at room level
      "supplements": [
        {
          "Type": "AtProperty",
          "Description": "mandatory_tax",
          "Price": 10,
          "Currency": "AED",
          "ChargeType": "Fixed"
        },
        {
          "Type": "AtProperty",
          "Description": "Local City Tax",
          "Price": 2.5,
          "Currency": "AED"
        }
      ]
    }
  ],
  "searchReference": "1347149!TB!3!TB!e0ed6d7e-2426-11f1-aada-ba9013e35c3f!TB!N!TB!AFF!",
  "expiresAt": "2026-03-21T06:34:44.354Z",
  // ✅ NEW: Hotel-level supplement summary
  "supplementSummary": {
    "hasSupplements": true,
    "supplementCount": 2,
    "atPropertyChargeCount": 2,
    "requiresReview": false // Only AtProperty, no unknowns
  }
};

// ============================================================================
// 3. API ENDPOINT: POST /hotels/search (What frontend receives)
// ============================================================================

const frontendSearchResponse = {
  "success": true,
  "data": [
    //... backendNormalizedSearchResult structure repeated
  ]
};

// ============================================================================
// 4. TBO PREBOOK API RESPONSE (Raw from /PreBook endpoint)
// ============================================================================

const tboPreBookRawResponse = {
  "Status": {
    "Code": 200,
    "Description": "Successful"
  },
  "BookingCode": "TBOBOOK123456",
  "BookingReference": "REF-2026-001",
  "NetAmount": 4567.22,
  "TotalFare": 4567.22,
  "IsPriceChanged": false,
  "IsCancellationPolicyChanged": false,
  // ✅ Hotel room details with MandatorySupplements
  "HotelRoomsDetails": [
    {
      "RoomName": "Standard King Room",
      "BasePrice": 3723.07,
      "TotalFare": 4567.22,
      "RoomPromotion": ["Save:10%"],
      "Inclusion": "Free breakfast,Free self parking",
      "RateConditions": [
        "Free cancellation until 48 hours before arrival"
      ],
      "CancelPolicies": [
        {
          "FromDate": "2026-03-19",
          "ChargeType": "Fixed",
          "CancellationCharge": 0
        },
        {
          "FromDate": "2026-05-01",
          "ChargeType": "Percentage",
          "CancellationCharge": 100
        }
      ],
      // ✅ NEW: MandatorySupplements in prebook
      "MandatorySupplements": [
        {
          "Type": "AtProperty",
          "Description": "mandatory_tax",
          "Price": 10,
          "Currency": "AED",
          "ChargeType": "Fixed"
        }
      ]
    }
  ]
};

// ============================================================================
// 5. TBO BOOKING SERVICE EXTRACTS & NORMALIZES
// Internal normalization in tbo-hotel-booking.service.ts
// ============================================================================

const normalizedSupplements = [
  {
    "type": "AtProperty",
    "description": "mandatory_tax",
    "amount": 10,
    "currency": "AED",
    "source": "prebook", // Marked as from prebook, not search
    "paymentLocation": "HOTEL",
    "payableAtHotel": true,
    "includedInPrice": false,
    "isMandatory": true,
    "chargeType": "Fixed",
    "fromDate": undefined,
    "toDate": undefined,
    "rawData": {
      "Type": "AtProperty",
      "Description": "mandatory_tax",
      "Price": 10,
      "Currency": "AED",
      "ChargeType": "Fixed"
    }
  }
];

// ============================================================================
// 6. CONFIRM QUOTATION API RESPONSE
// POST /itineraries/confirm-quotation
// ============================================================================

const confirmQuotationResponse = {
  "success": true,
  "message": "Prebook completed for 1 hotel(s)",
  "itinerary_plan_ID": 12345,
  "hotels": [
    {
      "routeId": 123,
      "hotelCode": "1347149",
      "bookingCode": "TBOBOOK123456",
      "updatedTotalPrice": 4567.22,
      "finalPrice": 4567.22,
      "totalAmount": 4567.22,
      // ✅ Raw mandatory supplements (backward compat)
      "mandatorySupplements": [
        {
          "Type": "AtProperty",
          "Description": "mandatory_tax",
          "Price": 10,
          "Currency": "AED"
        }
      ],
      // ✅ NEW: Normalized supplements for display
      "normalizedSupplements": [
        {
          "type": "AtProperty",
          "description": "mandatory_tax",
          "amount": 10,
          "currency": "AED",
          "source": "prebook",
          "paymentLocation": "HOTEL",
          "payableAtHotel": true,
          "includedInPrice": false,
          "isMandatory": true,
          "chargeType": "Fixed",
          "rawData": {
            "Type": "AtProperty",
            "Description": "mandatory_tax",
            "Price": 10,
            "Currency": "AED"
          }
        }
      ],
      // ✅ NEW: Raw supplements array
      "supplements": [],
      "cancellationPolicy": [
        {
          "FromDate": "2026-03-19",
          "ChargeType": "Fixed",
          "CancellationCharge": 0
        },
        {
          "FromDate": "2026-05-01",
          "ChargeType": "Percentage",
          "CancellationCharge": 100
        }
      ],
      "rateConditions": ["Free cancellation until 48 hours"],
      "inclusions": ["Free breakfast", "Free self parking"],
      "isPriceChanged": false,
      "isCancellationPolicyChanged": false
    }
  ],
  "updatedTotalPrice": 4567.22,
  "finalPrice": 4567.22,
  "totalAmount": 4567.22,
  "cancellationPolicy": "[{...}]",
  "rateConditions": [
    "Free cancellation until 48 hours before arrival"
  ],
  "inclusions": ["Free breakfast", "Free self parking"],
  // ✅ Aggregated from all hotels
  "mandatorySupplements": [
    {
      "Type": "AtProperty",
      "Description": "mandatory_tax",
      "Price": 10,
      "Currency": "AED"
    }
  ],
  // ✅ NEW: Aggregated normalized
  "normalizedSupplements": [
    {
      "type": "AtProperty",
      "description": "mandatory_tax",
      "amount": 10,
      "currency": "AED",
      "source": "prebook",
      "paymentLocation": "HOTEL",
      "payableAtHotel": true,
      "includedInPrice": false,
      "isMandatory": true
    }
  ]
};

// ============================================================================
// 7. FRONTEND RECEIVES (In ItineraryDetails.tsx)
// ============================================================================

const frontendPrebookData = confirmQuotationResponse.hotels[0];

// This is then passed to SupplementDisplay component:
// <SupplementDisplay supplements={frontendPrebookData.normalizedSupplements} />

// ============================================================================
// 8. EXAMPLE: UNKNOWN SUPPLEMENT TYPE (Future-safe)
// ============================================================================

const futureUnknownSupplementFromTBO = {
  "Type": "MysteryFutureType",          // Unknown to our code
  "Description": "Future charge we don't understand",
  "Price": 15,
  "Currency": "INR",
  "SomeNewField": "value"
};

// Our normalizer safely handles it:
const normalizedUnknownSupplement = {
  "type": "MysteryFutureType",          // Preserved original
  "description": "Future charge we don't understand",
  "amount": 15,
  "currency": "INR",
  "source": "prebook",
  "paymentLocation": "UNKNOWN",          // ⚠️ Not assuming it's at hotel
  "payableAtHotel": false,               // ⚠️ Not assuming
  "includedInPrice": false,               // Conservative: assume not included
  "isMandatory": false,                   // Not marked as mandatory
  "chargeType": undefined,
  "rawData": futureUnknownSupplementFromTBO
  // ⚠️ System logs: "Unknown supplement type encountered: MysteryFutureType"
};

// Frontend SupplementDisplay renders with warning:
// ┌─────────────────────────────┐
// │ ⚠️  Other Charges            │
// │ MysteryFutureType           │ INR 15.00
// │ Please review & contact     │
// │ hotel for details.          │
// └─────────────────────────────┘

// ============================================================================
// 9. DATABASE PERSISTENCE
// dvi_itinerary_plan_hotel_details.mandatory_supplements
// ============================================================================

const databaseEntry = {
  "itinerary_plan_hotel_details_ID": 999,
  "itinerary_plan_id": 12345,
  "itinerary_route_id": 123,
  "hotel_id": 1347149,
  "hotel_name": "Pearl Delta Dubai",
  "check_in_date": "2026-05-04",
  "check_out_date": "2026-05-05",
  "no_of_rooms": 1,
  "net_amount": 4567.22,
  // ✅ Stored raw supplements
  "mandatory_supplements": [
    {
      "Type": "AtProperty",
      "Description": "mandatory_tax",
      "Price": 10,
      "Currency": "AED"
    }
  ],
  "created_at": "2026-03-20T10:30:00Z",
  "created_by": 1
};

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

module.exports = {
  tboSearchRawResponse,
  backendNormalizedSearchResult,
  frontendSearchResponse,
  tboPreBookRawResponse,
  normalizedSupplements,
  confirmQuotationResponse,
  frontendPrebookData,
  futureUnknownSupplementFromTBO,
  normalizedUnknownSupplement,
  databaseEntry
};
