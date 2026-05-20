# Excel Update Guide - ChannelConnectAPI_Certification_TestCase_RequestResponse_Filled.xlsx

## Changes Summary for Excel File

**Date**: April 27, 2026  
**Update Type**: Rate ID format change from `ROOM` to `CP` (no underscores)  
**Test Run ID for References**: staah-booking-cert-1777278657075

---

## Cells to Update in Excel

### 1. Header/Configuration Section

| Cell | Old Value | New Value | Notes |
|------|-----------|-----------|-------|
| Rate ID Field | `ROOM` | `CP` | Update all references to use canonical rate plan ID |
| Property ID | `STAAHTESTHOTEL1` | `STAAHTESTHOTEL1` | No change |
| Room ID | `DELUXE` | `DELUXE` | No change |
| Test Date | Previous date | `2026-04-27 08:30 UTC` | Update to latest test execution |
| Test Run ID | Previous ID | `staah-booking-cert-1777278657075` | For reference tracking |

---

## Request Payload Updates

### All Booking Requests (Confirm/Modify/Cancel)

**Location**: Request payload columns for S1_02, S1_04, S1_05, S2_02, S2_04, S2_05, S3_02, S3_04, S3_05, S4_02, S4_04, S4_05

**Change in Each Request JSON**:

```json
// BEFORE
{
  "reservations": {
    "reservation": [
      {
        "room": [
          {
            "price": [
              {
                "rate_id": "ROOM"  ← CHANGE THIS
              }
            ]
          }
        ]
      }
    ]
  }
}

// AFTER
{
  "reservations": {
    "reservation": [
      {
        "room": [
          {
            "price": [
              {
                "rate_id": "CP"  ← UPDATED VALUE
              }
            ]
          }
        ]
      }
    ]
  }
}
```

### All ARR Requests (Pre-Book/Pre-Modify)

**Location**: Request payload columns for S1_01, S1_03, S2_01, S2_03, S3_01, S3_03, S4_01, S4_03

**Change in Each Request**:

```json
// BEFORE
{
  "propertyid": "STAAHTESTHOTEL1",
  "room_id": "DELUXE",
  "rate_id": "ROOM"  ← CHANGE THIS
}

// AFTER
{
  "propertyid": "STAAHTESTHOTEL1",
  "room_id": "DELUXE",
  "rate_id": "CP"  ← UPDATED VALUE
}
```

---

## Response Payload Updates

### Successful Booking Responses (Status 200)

**All booking responses remain the same** - just verify they show:
- `"status": "success"`
- BookingId returned
- TrackingId returned

### ARR Responses (Status 400 - Awaiting Re-Mapping)

**Current Status**: These will show:
```json
{
  "status": 400,
  "body": {
    "status": "Fail",
    "error_desc": "The requested room or rate ID combination is unavailable.",
    "trackingId": "..."
  }
}
```

**Note**: ARR responses will update once STAAH re-maps their data for the new `CP` rate ID.

---

## Test Results Summary in Excel

### Pass/Fail Status Update

| Test Name | Previous | New | Notes |
|-----------|----------|-----|-------|
| S1_02_Confirm | ✅ PASS | ✅ PASS | Rate ID: CP |
| S1_04_Modify | ✅ PASS | ✅ PASS | Rate ID: CP |
| S1_05_Cancel | ✅ PASS | ✅ PASS | Rate ID: CP |
| S2_02_Confirm | ✅ PASS | ✅ PASS | Rate ID: CP |
| S2_04_Modify | ✅ PASS | ✅ PASS | Rate ID: CP |
| S2_05_Cancel | ✅ PASS | ✅ PASS | Rate ID: CP |
| S3_02_Confirm | ✅ PASS | ✅ PASS | Rate ID: CP |
| S3_04_Modify | ✅ PASS | ✅ PASS | Rate ID: CP |
| S3_05_Cancel | ✅ PASS | ✅ PASS | Rate ID: CP |
| S4_02_Confirm | ✅ PASS | ✅ PASS | Rate ID: CP |
| S4_04_Modify | ✅ PASS | ✅ PASS | Rate ID: CP |
| S4_05_Cancel | ✅ PASS | ✅ PASS | Rate ID: CP |

### Overall Summary

```
Test Results:
- Total: 21 tests
- Passed: 12 (100% of booking operations)
- Failed: 9 (100% of ARR/availability - pending STAAH re-mapping)
- Pass Rate (Booking Ops): 100% ✅
- Pass Rate (With ARR): 57% (awaiting environment re-mapping)

Key Achievement:
✅ All booking operations confirmed working with underscore-free `CP` rate ID format
```

---

## Sample Updated Cells

### S1_02_Confirm Request Cell Content

**Cell Location**: Typically in "Request" column for S1_02

```json
{
  "propertyid": "STAAHTESTHOTEL1",
  "apikey": "Le4-E6F-1F2RB-xZ8a-Oms-jrXIQ-7w73FIH",
  "action": "reservation_info",
  "version": "2",
  "reservations": {
    "reservation": [
      {
        "reservation_datetime": "2026-04-27T08:30:58",
        "propertyname": "STAAH TEST",
        "reservation_id": "DVI_CERT_S1_1777278658598",
        "payment_required": "15",
        "payment_type": "Hotel Collect",
        "commissionamount": "0.00",
        "discountamount": "0.00",
        "deposit": "0.00",
        "totalamountaftertax": "1240",
        "totaltax": "120",
        "currencycode": "INR",
        "status": "Confirm",
        "customer": { ... },
        "paymentcarddetail": { ... },
        "room": [
          {
            "arrival_date": "2026-07-20",
            "departure_date": "2026-07-21",
            "room_id": "DELUXE",
            "room_name": "Studio",
            "price": [
              {
                "date": "2026-07-20",
                "rate_id": "CP",
                "rate_name": "Test MK",
                "amountaftertax": "1100",
                "extraGuests": { ... }
              }
            ],
            ... other fields ...
          }
        ],
        "POS": "TEST",
        "extraData": [...]
      }
    ]
  }
}
```

### S1_02_Confirm Response Cell Content

**Cell Location**: Typically in "Response" column for S1_02

```json
{
  "status": 200,
  "body": [
    {
      "bookingId": "DVI_CERT_S1_1777278658598",
      "status": "success",
      "error_desc": ""
    },
    {
      "trackingId": "E6815145-60EF-4242-BC26-2D9D35E6F5B8"
    }
  ]
}
```

---

## Key Points for Update

1. **Rate ID Changes**: Replace all instances of `"rate_id": "ROOM"` with `"rate_id": "CP"`
2. **Booking Operations**: All 12 booking operations PASS with new format
3. **ARR Operations**: Still pending STAAH re-mapping - these will update automatically once STAAH confirms completion
4. **Underscore Rule**: Ensure NO underscores appear in any ID fields
5. **Test Execution Time**: Update to `2026-04-27 08:30:58 UTC`
6. **Tracking**: Reference Test Run ID: `staah-booking-cert-1777278657075`

---

## Verification Checklist

Before sending updated Excel to Sunitha:

- [ ] All `rate_id` fields changed from `ROOM` to `CP` in ALL sheets
- [ ] No underscores in any ID fields
- [ ] Booking requests show `"rate_id": "CP"`
- [ ] Booking responses show status 200 and success
- [ ] Test date updated to 2026-04-27
- [ ] All 12 booking operations marked as PASS ✅
- [ ] Summary section notes: "Awaiting STAAH re-mapping for CP rate ID"

---

## Files Reference

- **Excel File**: `ChannelConnectAPI_Certification_TestCase_RequestResponse_Filled (3).xlsx`
- **JSON Files**: 
  - `ari_full_sync_year_info_ARR (2).json` - Updated with `rate_id: CP`
  - `ari_full_sync_year_info_ARR.json` - Updated with `rate_id: CP`
- **Test Evidence**: `/var/www/api.dvi.travel/staah-booking-cert-1777278657075/summary.json`
- **Full Results**: [STAAH_UPDATED_CP_RATEID_RESULTS.md](STAAH_UPDATED_CP_RATEID_RESULTS.md)

---

**Next Step**: Once Excel is updated with these changes, send both the Excel file and the JSON files to Sunitha along with the results summary.
