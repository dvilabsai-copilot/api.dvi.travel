# TBO Hotel Booking - End-to-End Proof of Fix (PROD)
**Quote:** DVI20260517 | **Date Tested:** 05 May 2026 | **Backend PID:** 1368831

---

## Response to Raised Blockers

> *As discussed, there were 3 blockers:*
> 1. *Multi-room booking*
> 2. *Booking with child*
> 3. *Passing TotalFare in the booking request instead of NetAmount*

**All 3 blockers are verified on production logs for Quote `DVI20260517`.**

---

## Trip Details

| Field | Value |
|---|---|
| Quote ID | DVI20260517 |
| Itinerary | Chennai International Airport -> Chennai -> Mahabalipuram -> Pondicherry |
| Travel Dates | 13 May - 16 May 2026 (3 nights) |
| Rooms | **2 rooms** |
| Adults | 2 (1 per room) |
| Children | **2** (ages **7** and **6**, 1 per room) |
| Guest Nationality | AE (search) / IN (booking) |

---

## Blocker Fix Evidence

### Fix 1 - Multi-Room Booking ✅

Production PreBook payloads show **2 separate room occupancies**:

```json
"PaxRooms": [
  { "Adults": 1, "Children": 1, "ChildrenAges": [7] },
  { "Adults": 1, "Children": 1, "ChildrenAges": [6] }
]
```

Production booking payloads also show **2 separate room objects** in `HotelRoomsDetails`.

---

### Fix 2 - Booking with Child (Correct Ages) ✅

Child ages are read from travellers and propagated end-to-end:

```text
[ItineraryHotelDetailsTboService] 👦 Child ages from travellers: [7, 6]
```

Both PreBook and Book payloads include the same age split (`[7]` and `[6]`) room-wise.

---

### Fix 3 - NetAmount (not TotalFare) in Booking Request ✅

The booking payload sends exact `NetAmount` from PreBook context, not rounded `TotalFare`.

| Hotel | TotalFare (old, wrong) | NetAmount (new, correct) | Difference |
|---|---|---|---|
| S4 Residency | 2113.36 | **2113.67203689** | +0.31 |
| OYO 9443 Hotel Ramakrishna | 3790.56 | **3790.9692449840004** | +0.41 |
| Hotel Signature Inn | 3903.38 | **3903.7930065299997** | +0.41 |

Log-backed `prebookContext` values:
```text
prebookNetAmount: 2113.67203689
prebookNetAmount: 3790.9692449840004
prebookNetAmount: 3903.7930065299997
```

Booking payloads use these exact values in `NetAmount`.

---

## Hotel 1 - S4 Residency, Chennai (Route 1920)

### PREBOOK
```text
Booking Code: 1750094!TB!1!TB!7cb9619f-4810-11f1-84ef-720abae076dd!TB!N!TB!AFF!
PaxRooms:      [{Adults:1, Children:1, ChildrenAges:[7]}, {Adults:1, Children:1, ChildrenAges:[6]}]
TotalFare:     2113.36
NetAmount:     2113.67203689
```

### BOOK
```text
NetAmount in payload: 2113.67203689
HotelRoomsDetails:    2 room objects with child ages 7 and 6
```

### CONFIRMATION ✅
```text
HotelBookingStatus: Confirmed
BookingId:          2120644
InvoiceNumber:      MW/2627/3475
ConfirmationNo:     7725248907998
BookingRefNo:       789304944551778,681616663582351
VoucherStatus:      true
IsPriceChanged:     false
```

---

## Hotel 2 - OYO 9443 Hotel Ramakrishna, Mahabalipuram (Route 1921)

### PREBOOK
```text
Booking Code: 1089692!TB!1!TB!7cb88e48-4810-11f1-84ef-720abae076dd!TB!N!TB!AFF!
PaxRooms:      [{Adults:1, Children:1, ChildrenAges:[7]}, {Adults:1, Children:1, ChildrenAges:[6]}]
TotalFare:     3790.56
NetAmount:     3790.9692449840004
```

### BOOK
```text
NetAmount in payload: 3790.9692449840004
HotelRoomsDetails:    2 room objects with child ages 7 and 6
```

### CONFIRMATION ✅
```text
HotelBookingStatus: Confirmed
BookingId:          2120645
InvoiceNumber:      MW/2627/3476
ConfirmationNo:     7613777452059
BookingRefNo:       487836253848705,930903534965591
VoucherStatus:      true
IsPriceChanged:     false
```

---

## Hotel 3 - Hotel Signature Inn, Pondicherry (Route 1922)

### PREBOOK
```text
Booking Code: 1883762!TB!1!TB!7cc6f8c7-4810-11f1-84ef-720abae076dd!TB!N!TB!AFF!
PaxRooms:      [{Adults:1, Children:1, ChildrenAges:[7]}, {Adults:1, Children:1, ChildrenAges:[6]}]
TotalFare:     3903.38
NetAmount:     3903.7930065299997
```

### BOOK
```text
NetAmount in payload: 3903.7930065299997
HotelRoomsDetails:    2 room objects with child ages 7 and 6
```

### CONFIRMATION ✅
```text
HotelBookingStatus: Confirmed
BookingId:          2120646
InvoiceNumber:      MW/2627/3477
ConfirmationNo:     7521402360890
BookingRefNo:       470419392701559,402503486616672
VoucherStatus:      true
IsPriceChanged:     false
```

---

## Summary Table

| # | Hotel | City | Booking Code (TBO) | PreBook NetAmount (INR) | BookingId | ConfirmationNo | Status |
|---|---|---|---|---|---|---|---|
| 1 | S4 Residency | Chennai | `1750094!TB!1!TB!7cb9619f-...` | 2113.67203689 | 2120644 | 7725248907998 | ✅ Confirmed |
| 2 | OYO 9443 Hotel Ramakrishna | Mahabalipuram | `1089692!TB!1!TB!7cb88e48-...` | 3790.9692449840004 | 2120645 | 7613777452059 | ✅ Confirmed |
| 3 | Hotel Signature Inn | Pondicherry | `1883762!TB!1!TB!7cc6f8c7-...` | 3903.7930065299997 | 2120646 | 7521402360890 | ✅ Confirmed |

**Total NetAmount billed to TBO limit:** INR 9,808.43

---

## Blocker Resolution Summary

| Blocker | Issue | Fix Applied | Verified |
|---|---|---|---|
| 1 - Multi-room | Single combined room was being sent | 2 separate `PaxRooms` / `HotelRoomsDetails` objects, 1 per room | ✅ All 3 bookings confirmed with 2 rooms |
| 2 - Child booking | Child age handling mismatch risk | Child ages read from travellers and split room-wise | ✅ Ages [7, 6] sent in prebook + booking payloads |
| 3 - NetAmount vs TotalFare | `TotalFare` could be sent in booking request | `prebookNetAmount` reused in booking payload `NetAmount` | ✅ Exact decimals confirmed in all 3 booking calls |

---

## Raw Production Markers (pm2)

```text
[TboHotelBookingService] 📥 PreBook API raw response ... "HotelCode":"1750094" ... "TotalFare":2113.36 ... "NetAmount":2113.67203689
[TboHotelBookingService] 📥 PreBook API raw response ... "HotelCode":"1089692" ... "TotalFare":3790.56 ... "NetAmount":3790.9692449840004
[TboHotelBookingService] 📥 PreBook API raw response ... "HotelCode":"1883762" ... "TotalFare":3903.38 ... "NetAmount":3903.7930065299997

[TboHotelBookingService] 📝 Booking: Hotel 1750094 ... "NetAmount":2113.67203689
[TboHotelBookingService] 📝 Booking: Hotel 1089692 ... "NetAmount":3790.9692449840004
[TboHotelBookingService] 📝 Booking: Hotel 1883762 ... "NetAmount":3903.7930065299997

[TboHotelBookingService] 📥 Book API Response ... "BookingId":2120644 ... "HotelBookingStatus":"Confirmed"
[TboHotelBookingService] 📥 Book API Response ... "BookingId":2120645 ... "HotelBookingStatus":"Confirmed"
[TboHotelBookingService] 📥 Book API Response ... "BookingId":2120646 ... "HotelBookingStatus":"Confirmed"
```