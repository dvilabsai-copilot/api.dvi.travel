const axios = require("axios");
const BASE_URL = "http://localhost:4006/api";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testBookingSuccess() {
  try {
    console.log("\n[1] Creating new itinerary...");
    const createResp = await axios.post(
      `${BASE_URL}/itineraries/create-itinerary`,
      {
        traveler_name: "Test Traveler",
        travel_start_date: "2026-05-15",
        travel_end_date: "2026-05-18",
        currency_code: "AED",
        total_budget: 10000,
        destinations: [
          {
            destination_name: "Dubai",
            start_date: "2026-05-15",
            end_date: "2026-05-18",
          },
        ],
      }
    );

    const itineraryId = createResp.data.data?.itinerary_ID;
    console.log(`✓ Created itinerary: ${itineraryId}`);

    // Get hotel search results
    console.log("\n[2] Getting hotel search results...");
    const hotelResp = await axios.get(
      `${BASE_URL}/itineraries/${itineraryId}/hotels/search?destination=Dubai&checkin=2026-05-15&checkout=2026-05-16`
    );

    const hotels = hotelResp.data.data || [];
    console.log(`✓ Found ${hotels.length} hotels`);

    if (hotels.length < 1) {
      console.log("No hotels available for booking test");
      return;
    }

    // Create quote with first hotel
    console.log("\n[3] Creating quote with hotel selection...");
    const quoteResp = await axios.post(
      `${BASE_URL}/itineraries/${itineraryId}/create-quotation`,
      {
        hotel_bookings: [
          {
            destination: "Dubai",
            check_in_date: "2026-05-15",
            check_out_date: "2026-05-16",
            hotel_code: hotels[0].hotel_code || "TEST_HOTEL",
            provider: hotels[0].provider || "TBO",
            room_type: "Deluxe",
            adults: 2,
            children: 0,
            price_per_night: hotels[0].price || 500,
            total_price: hotels[0].price || 500,
          },
        ],
      }
    );

    const quoteId = quoteResp.data.data?.quotation_ID;
    const planId = quoteResp.data.data?.itinerary_plan_ID;
    console.log(`✓ Created quote: ${quoteId}`);
    console.log(`✓ Plan ID: ${planId}`);

    // Wait a bit for initial state
    await sleep(1000);

    // Check quote status before confirmation
    console.log("\n[4] Checking quote status BEFORE confirmation...");
    const statusBefore = await axios.get(
      `${BASE_URL}/itineraries/${planId}/quotation-status`
    );
    console.log(
      `✓ Quotation status (before): ${statusBefore.data.data?.quotation_status}`
    );
    console.log(
      `  Raw data:`,
      JSON.stringify(statusBefore.data.data, null, 2)
    );

    // Confirm the booking
    console.log("\n[5] Confirming booking...");
    const confirmResp = await axios.post(
      `${BASE_URL}/itineraries/${planId}/confirm-quotation`,
      {
        payment_method: "wallet",
        traveler_email: "test@example.com",
      }
    );

    console.log(`✓ Confirmation response:`, JSON.stringify(confirmResp.data, null, 2));
    await sleep(2000);

    // Check quote status after confirmation
    console.log("\n[6] Checking quote status AFTER confirmation...");
    const statusAfter = await axios.get(
      `${BASE_URL}/itineraries/${planId}/quotation-status`
    );
    const finalStatus = statusAfter.data.data?.quotation_status;
    console.log(`✓ Quotation status (after): ${finalStatus}`);
    console.log(`  Raw data:`, JSON.stringify(statusAfter.data.data, null, 2));

    if (finalStatus === 1) {
      console.log("\n✅ SUCCESS: Quote confirmed successfully!");
    } else if (finalStatus === 0) {
      console.log(
        "\n⚠️  PARTIAL: Quote still draft (bookings may still be pending)"
      );
    } else {
      console.log(`\n❌ UNKNOWN STATUS: ${finalStatus}`);
    }

    console.log("\n=== TEST COMPLETE ===");
    process.exit(0);
  } catch (error) {
    console.error(
      "\n❌ Error:",
      error.response?.data || error.message
    );
    process.exit(1);
  }
}

testBookingSuccess();
