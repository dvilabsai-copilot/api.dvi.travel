# TBO Hotel Booking – End-to-End Proof of Fix
**Quote:** DVI2026057 | **Date Tested:** 05 May 2026 | **Backend PID:** 42640

---

## Response to Raised Blockers

> *Thank you for the call. As discussed, there were 3 blockers:*
> 1. *Multi-room booking*
> 2. *Booking with child*
> 3. *Passing TotalFare in the booking request instead of NetAmount*

**All 3 blockers have been identified, fixed, and verified end-to-end.** The evidence below traces each hotel from TBO search → prebook → book → confirmation.

---

## Trip Details

| Field | Value |
|---|---|
| Quote ID | DVI2026057 |
 
| Itinerary | Chennai International Airport → Chennai → Mahabalipuram → Pondicherry |
| Travel Dates | 13 May – 16 May 2026 (3 nights) |
| Rooms | **2 rooms** |
| Adults | 2 (1 per room) |
| Children | **2** (ages **7** and **6**, 1 per room) |
| Guest Nationality | IN |

---

## Blocker Fix Evidence

### Fix 1 – Multi-Room Booking ✅

Every TBO search request, prebook call, and final booking payload correctly sends **2 separate room occupancies** (not a single combined room):

```json
"PaxRooms": [
  { "Adults": 1, "Children": 1, "ChildrenAges": [7] },
  { "Adults": 1, "Children": 1, "ChildrenAges": [6] }
]
```

And in the booking `HotelRoomsDetails`, 2 separate room objects are sent:
```json
"HotelRoomsDetails": [
  { "HotelPassenger": [ { Lead adult }, { Child age 7 } ] },
  { "HotelPassenger": [ { Adult },      { Child age 6 } ] }
]
```

---

### Fix 2 – Booking with Child (Correct Ages) ✅

Child ages are now **read from the traveller database** (`dvi_itinerary_traveller_details`) and passed correctly.

**Log evidence:**
```
[ItineraryHotelDetailsTboService] 👦 Child ages from travellers: [7, 6]
```

Previously the system was hardcoding `ChildrenAges: [6]`. Now both ages (7 and 6) are distributed one per room across all 3 search calls, all 3 prebook calls, and all 3 final booking calls.

---

### Fix 3 – NetAmount (not TotalFare) in Booking Request ✅

The booking payload now sends the exact `NetAmount` from TBO's prebook response — **not** the rounded `TotalFare`.

| Hotel | TotalFare (old, wrong) | NetAmount (new, correct) | Difference |
|---|---|---|---|
| S4 Residency | 2113.36 | **2113.67203689** | +0.31 |
| OYO 9443 Ramakrishna | 3790.56 | **3790.9692449840004** | +0.41 |
| Hotel Signature Inn | 3903.38 | **3903.7930065299997** | +0.41 |

**Log evidence — actual booking payloads sent to TBO:**
```
Hotel 1750094: "NetAmount": 2113.67203689
Hotel 1089692: "NetAmount": 3790.9692449840004
Hotel 1883762: "NetAmount": 3903.7930065299997
```

---

## Hotel 1 – S4 Residency, Chennai (Route 3336)

### SEARCH
```
City Code:    127343 (Chennai)
Check-In:     2026-05-13
Check-Out:    2026-05-14
Rooms:        2
PaxRooms:     [{Adults:1, Children:1, ChildrenAges:[7]}, {Adults:1, Children:1, ChildrenAges:[6]}]
Nationality:  AE (search) / IN (booking)
```
**Result:** Hotel found in TBO search results

### PREBOOK
```
Booking Code: 1750094!TB!1!TB!5d872c9b-4806-11f1-84ef-720abae076dd!TB!N!TB!AFF!
PaymentMode:  Limit
PaxRooms:     [{Adults:1, Children:1, ChildrenAges:[7]}, {Adults:1, Children:1, ChildrenAges:[6]}]
```
**TBO PreBook Response:**
```
Status:       200 – Successful
Room:         Standard Room, 1 Double Bed, NonSmoking (×2)
TotalFare:    INR 2113.36
NetAmount:    INR 2113.67203689   ← stored as prebookNetAmount
Currency:     INR
Last Cancel:  11-05-2026 23:59:59 (Refundable)
```

### BOOK
```
BookingCode:  1750094!TB!1!TB!5d872c9b-4806-11f1-84ef-720abae076dd!TB!N!TB!AFF!
NetAmount:    2113.67203689   ← exact value, not rounded TotalFare
NoOfRooms:    2
HotelRoomsDetails: 2 rooms with correct pax + child ages
```

### CONFIRMATION ✅
```
HotelBookingStatus: Confirmed
BookingId:          2120634
InvoiceNumber:      MW/2627/3472
ConfirmationNo:     7901992698964
BookingRefNo:       635041840038299, 713058128025579
VoucherStatus:      true
IsPriceChanged:     false
```

---

## Hotel 2 – OYO 9443 Hotel Ramakrishna, Mahabalipuram (Route 3337)

### SEARCH
```
City Code:    126117 (Mahabalipuram)
Check-In:     2026-05-14
Check-Out:    2026-05-15
Rooms:        2
PaxRooms:     [{Adults:1, Children:1, ChildrenAges:[7]}, {Adults:1, Children:1, ChildrenAges:[6]}]
```
**Result:** Hotel found in TBO search results (79 hotels in city, 9 returned with availability)

### PREBOOK
```
Booking Code: 1089692!TB!1!TB!5d84a4aa-4806-11f1-84ef-720abae076dd!TB!N!TB!AFF!
PaymentMode:  Limit
PaxRooms:     [{Adults:1, Children:1, ChildrenAges:[7]}, {Adults:1, Children:1, ChildrenAges:[6]}]
```
**TBO PreBook Response:**
```
Status:       200 – Successful
Room:         Compact A/C Room, 1 Double Bed, NonSmoking (×2)
TotalFare:    INR 3790.56
NetAmount:    INR 3790.9692449840004   ← stored as prebookNetAmount
Currency:     INR
Last Cancel:  03-05-2026 23:59:59 (Non-refundable)
```

### BOOK
```
BookingCode:  1089692!TB!1!TB!5d84a4aa-4806-11f1-84ef-720abae076dd!TB!N!TB!AFF!
NetAmount:    3790.9692449840004   ← exact value, not rounded TotalFare
NoOfRooms:    2
HotelRoomsDetails: 2 rooms with correct pax + child ages
```

### CONFIRMATION ✅
```
HotelBookingStatus: Confirmed
BookingId:          2120635
InvoiceNumber:      MW/2627/3473
ConfirmationNo:     7677224184336
BookingRefNo:       416238412500349, 447815456891726
VoucherStatus:      true
IsPriceChanged:     false
```

---

## Hotel 3 – Hotel Signature Inn, Pondicherry (Route 3338)

### SEARCH
```
City Code:    150358 (Pondicherry) — fallback via dvi_hotel table (67 hotels)
Check-In:     2026-05-15
Check-Out:    2026-05-16
Rooms:        2
PaxRooms:     [{Adults:1, Children:1, ChildrenAges:[7]}, {Adults:1, Children:1, ChildrenAges:[6]}]
```
**Result:** 19 hotels returned with availability

### PREBOOK
```
Booking Code: 1883762!TB!1!TB!5d96682c-4806-11f1-84ef-720abae076dd!TB!N!TB!AFF!
PaymentMode:  Limit
PaxRooms:     [{Adults:1, Children:1, ChildrenAges:[7]}, {Adults:1, Children:1, ChildrenAges:[6]}]
```
**TBO PreBook Response:**
```
Status:       200 – Successful
Room:         Executive Double Room, 1 Double Bed, NonSmoking (×2)
TotalFare:    INR 3903.38
NetAmount:    INR 3903.7930065299997   ← stored as prebookNetAmount
Currency:     INR
Last Cancel:  13-05-2026 23:59:59 (Refundable)
```

### BOOK
```
BookingCode:  1883762!TB!1!TB!5d96682c-4806-11f1-84ef-720abae076dd!TB!N!TB!AFF!
NetAmount:    3903.7930065299997   ← exact value, not rounded TotalFare
NoOfRooms:    2
HotelRoomsDetails: 2 rooms with correct pax + child ages
```

### CONFIRMATION ✅
```
HotelBookingStatus: Confirmed
BookingId:          2120636
InvoiceNumber:      MW/2627/3474
ConfirmationNo:     7972313249538
BookingRefNo:       348058419578644, 931697450229243
VoucherStatus:      true
IsPriceChanged:     false
```

---

## Summary Table

| # | Hotel | City | Booking Code (TBO) | PreBook NetAmount (INR) | BookingId | ConfirmationNo | Status |
|---|---|---|---|---|---|---|---|
| 1 | S4 Residency | Chennai | `1750094!TB!1!TB!5d872c9b-...` | 2113.67203689 | 2120634 | 7901992698964 | ✅ Confirmed |
| 2 | OYO 9443 Hotel Ramakrishna | Mahabalipuram | `1089692!TB!1!TB!5d84a4aa-...` | 3790.9692449840004 | 2120635 | 7677224184336 | ✅ Confirmed |
| 3 | Hotel Signature Inn | Pondicherry | `1883762!TB!1!TB!5d96682c-...` | 3903.7930065299997 | 2120636 | 7972313249538 | ✅ Confirmed |

**Total NetAmount billed to TBO limit:** INR 9,808.43

---

## Blocker Resolution Summary

| Blocker | Issue | Fix Applied | Verified |
|---|---|---|---|
| 1 – Multi-room | Single combined room was being sent | 2 separate `PaxRooms` / `HotelRoomsDetails` objects, 1 per room | ✅ All 3 bookings confirmed with 2 rooms |
| 2 – Child booking | `ChildrenAges` was hardcoded as `[6]` regardless of actual ages | Child ages now queried from `dvi_itinerary_traveller_details` table | ✅ Ages [7, 6] correctly sent throughout |
| 3 – NetAmount vs TotalFare | `TotalFare` (rounded) was sent in booking request | `NetAmount` extracted from prebook response and stored in `prebookContext.prebookNetAmount` | ✅ Exact decimals confirmed in all 3 booking payloads |
