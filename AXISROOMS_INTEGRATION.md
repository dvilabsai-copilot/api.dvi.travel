# AxisRooms Channel Manager Integration

## Overview

This document describes the AxisRooms Channel Manager OTA integration for DVI Backend. AxisRooms is integrated as a **push-based** inventory management system where AxisRooms pushes updates to our endpoints.

**Key Points:**
- ✅ AxisRooms pushes inventory, rates, and restrictions to DVI
- ✅ Hotels are mapped in `dvi_hotel` with `axisrooms_property_id`
- ✅ All endpoints are under `/api/v1/axisrooms/*`
- ✅ Authentication via API key in request body (`auth.key`)
- ⚠️ **NO MIGRATIONS** - This project uses `prisma db push` only

---

## Table of Contents

1. [Architecture](#architecture)
2. [Database Schema](#database-schema)
3. [API Endpoints](#api-endpoints)
4. [Authentication](#authentication)
5. [Setup Instructions](#setup-instructions)
6. [Testing](#testing)
7. [Postman Collection](#postman-collection)
8. [Troubleshooting](#troubleshooting)

---

## Architecture

### Flow Diagram

```
AxisRooms ──push──> DVI Backend API ──store──> MySQL Database
                    /api/v1/axisrooms/*
```

### Hotel Mapping

AxisRooms hotels are mapped into the `dvi_hotel` master table:

- `axisrooms_property_id` - AxisRooms property identifier (unique)
- `axisrooms_enabled` - Enable/disable flag (1 = enabled, 0 = disabled)

This allows us to:
1. Maintain a single hotel master table for all hotels
2. Support multiple suppliers per hotel (TBO, ResAvenue, AxisRooms)
3. Enable/disable AxisRooms sync per property
4. Track AxisRooms mappings independently from supplier-specific tables

---

## Database Schema

### Updated Model: `dvi_hotel`

Added fields:
```prisma
axisrooms_property_id  String?  @unique @db.VarChar(100)
axisrooms_enabled      Int      @default(0) @db.TinyInt
```

### New Models

#### 1. `axisrooms_room`
Stores room types (products) for each property.

```prisma
model axisrooms_room {
  id                      Int      @id @default(autoincrement())
  axisrooms_property_id   String   @db.VarChar(100)
  room_id                 String   @db.VarChar(100)
  room_name               String   @db.VarChar(255)
  created_at              DateTime @default(now())
  @@unique([axisrooms_property_id, room_id])
}
```

#### 2. `axisrooms_rateplan`
Stores rate plans for each room type.

```prisma
model axisrooms_rateplan {
  id                      Int      @id @default(autoincrement())
  axisrooms_property_id   String
  room_id                 String
  rateplan_id             String
  rateplan_name           String
  occupancy               Json     // Array: ["SINGLE", "DOUBLE", "TRIPLE"]
  commission_perc         String?
  tax_perc                String?
  currency                String?
  created_at              DateTime @default(now())
  @@unique([axisrooms_property_id, room_id, rateplan_id])
}
```

#### 3. `axisrooms_inventory`
Stores inventory updates (room availability).

```prisma
model axisrooms_inventory {
  id                      Int      @id @default(autoincrement())
  axisrooms_property_id   String
  room_id                 String
  start_date              DateTime @db.Date
  end_date                DateTime @db.Date
  free                    Int      // Available rooms
  received_at             DateTime @default(now())
  @@unique([axisrooms_property_id, room_id, start_date, end_date])
}
```

#### 4. `axisrooms_rate`
Stores rate updates with dynamic occupancy pricing.

```prisma
model axisrooms_rate {
  id                      Int      @id @default(autoincrement())
  axisrooms_property_id   String
  room_id                 String
  rateplan_id             String
  start_date              DateTime @db.Date
  end_date                DateTime @db.Date
  occupancy_rates         Json     // {"SINGLE": 5000, "DOUBLE": 6000, "TRIPLE": 7000}
  received_at             DateTime @default(now())
  @@unique([axisrooms_property_id, room_id, rateplan_id, start_date, end_date])
}
```

#### 5. `axisrooms_restriction`
Stores restrictions (Status, COA, COD, MLos).

```prisma
model axisrooms_restriction {
  id                      Int      @id @default(autoincrement())
  axisrooms_property_id   String
  room_id                 String
  rateplan_id             String
  start_date              DateTime @db.Date
  end_date                DateTime @db.Date
  type                    String   // Status | COA | COD | MLos
  value                   String   // Open/Close for Status/COA/COD, integer for MLos
  received_at             DateTime @default(now())
}
```

#### 6. `axisrooms_inbound_log`
Logs all inbound requests for debugging.

```prisma
model axisrooms_inbound_log {
  id                      Int      @id @default(autoincrement())
  type                    String   // productInfo | ratePlanInfo | inventoryUpdate | rateUpdate | restrictionUpdate
  axisrooms_property_id   String?
  room_id                 String?
  rateplan_id             String?
  payload                 Json     // Full request body
  received_at             DateTime @default(now())
}
```

---

## API Endpoints

All endpoints are prefixed with `/api/v1/axisrooms/`

### 1. POST `/api/v1/axisrooms/productInfo`

**Description:** Returns list of room types for a property.

**Request:**
```json
{
  "auth": { "key": "your-api-key" },
  "propertyId": "AX_TEST_HOTEL_1"
}
```

**Success Response:**
```json
{
  "message": "",
  "status": "success",
  "data": [
    { "name": "Deluxe Room", "id": "DELUXE_ROOM" },
    { "name": "Suite Room", "id": "SUITE_ROOM" }
  ]
}
```

**Failure Response:**
```json
{
  "message": "Invalid propertyId",
  "status": "failure",
  "data": []
}
```

---

### 2. POST `/api/v1/axisrooms/ratePlanInfo`

**Description:** Returns list of rate plans for a room.

**Request:**
```json
{
  "auth": { "key": "your-api-key" },
  "propertyId": "AX_TEST_HOTEL_1",
  "roomId": "DELUXE_ROOM"
}
```

**Success Response:**
```json
{
  "message": "",
  "status": "success",
  "data": [
    {
      "rateplanId": "CP_PLAN",
      "ratePlanName": "Continental Plan",
      "occupancy": ["SINGLE", "DOUBLE", "TRIPLE"],
      "validity": { "startDate": "2026-01-01", "endDate": "2099-12-31" },
      "commissionPerc": "10.0",
      "taxPerc": "5.0",
      "currency": "INR"
    }
  ]
}
```

---

### 3. POST `/api/v1/axisrooms/inventoryUpdate`

**Description:** AxisRooms pushes inventory updates.

**Request:**
```json
{
  "auth": { "key": "your-api-key" },
  "data": {
    "propertyId": "AX_TEST_HOTEL_1",
    "roomId": "DELUXE_ROOM",
    "inventory": [
      { "startDate": "2026-06-01", "endDate": "2026-06-05", "free": 10 },
      { "startDate": "2026-06-06", "endDate": "2026-06-10", "free": 5 }
    ]
  }
}
```

**Response:**
```json
{
  "message": "",
  "status": "success"
}
```

---

### 4. POST `/api/v1/axisrooms/rateUpdate`

**Description:** AxisRooms pushes rate updates with dynamic occupancy.

**Request:**
```json
{
  "auth": { "key": "your-api-key" },
  "data": {
    "propertyId": "AX_TEST_HOTEL_1",
    "roomId": "DELUXE_ROOM",
    "rateplanId": "CP_PLAN",
    "rate": [
      {
        "startDate": "2026-06-01",
        "endDate": "2026-06-05",
        "SINGLE": 5000,
        "DOUBLE": 6000,
        "TRIPLE": 7000,
        "EXTRABED": 1000
      }
    ]
  }
}
```

**Note:** Occupancy keys (SINGLE, DOUBLE, TRIPLE, EXTRABED, etc.) are dynamic and stored as JSON.

**Response:**
```json
{
  "message": "",
  "status": "success"
}
```

---

### 5. POST `/api/v1/axisrooms/restrictionUpdate`

**Description:** AxisRooms pushes restrictions.

**Request:**
```json
{
  "auth": { "key": "your-api-key" },
  "data": [
    {
      "propertyId": "AX_TEST_HOTEL_1",
      "roomDetails": [
        {
          "roomId": "DELUXE_ROOM",
          "ratePlanDetails": [
            {
              "ratePlanId": "CP_PLAN",
              "restrictions": {
                "periods": [
                  { "startDate": "2026-06-01", "endDate": "2026-06-05" }
                ],
                "type": "Status",
                "value": "Open"
              }
            }
          ]
        }
      ]
    }
  ]
}
```

**Restriction Types:**
- `Status`: Open/Close - Enable/disable bookings
- `COA`: Close on Arrival - Open/Close
- `COD`: Close on Departure - Open/Close
- `MLos`: Minimum Length of Stay - Integer value (e.g., "3" for 3 nights)

**Response:**
```json
{
  "message": "",
  "status": "success"
}
```

---

## Authentication

### API Key Authentication

AxisRooms endpoints use **body-based authentication**:

```json
{
  "auth": {
    "key": "your-api-key"
  },
  ...
}
```

### Validation Rules

1. API key is validated against `AXISROOMS_API_KEY` environment variable
2. Missing or invalid key returns HTTP 401:
   ```json
   {
     "message": "Unauthorized",
     "status": "failure"
   }
   ```

### Property Validation

All endpoints validate that:
- `propertyId` exists in `tbo_hotel_master.axisrooms_property_id`
- `axisrooms_enabled = 1`

Invalid property returns:
```json
{
  "message": "Invalid propertyId",
  "status": "failure"
}
```

---

## Setup Instructions

### Prerequisites

- Node.js (v16+)
- MySQL database
- Prisma CLI installed

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Configure Environment

Add to your `.env` file:

```env
# AxisRooms CM-OTA Configuration
AXISROOMS_API_KEY=your-axisrooms-api-key-here
```

### Step 3: Update Database Schema

⚠️ **Important:** This project uses `prisma db push`, **NOT migrations**.

```bash
# Push schema changes to database
npx prisma db push

# Generate Prisma client
npx prisma generate
```

### Step 4: Seed Test Data

```bash
# Seed test hotel and room data
npx ts-node seed-axisrooms-test-data.ts
```

This creates:
- Test hotel with `axisrooms_property_id = "AX_TEST_HOTEL_1"`
- 2 test rooms: DELUXE_ROOM, SUITE_ROOM
- 2 test rate plans: CP_PLAN, MAP_PLAN

### Step 5: Start Server

```bash
# Development mode
npm run start:dev

# Production mode
npm run build
npm run start:prod
```

Server will start on port defined in `.env` (default: 4006).

### Step 6: Verify Installation

```bash
curl -X POST http://localhost:4006/api/v1/axisrooms/productInfo \
  -H "Content-Type: application/json" \
  -d '{"auth":{"key":"your-api-key"},"propertyId":"AX_TEST_HOTEL_1"}'
```

Expected response:
```json
{
  "message": "",
  "status": "success",
  "data": [
    { "name": "Deluxe Room", "id": "DELUXE_ROOM" },
    { "name": "Suite Room", "id": "SUITE_ROOM" }
  ]
}
```

---

## Testing

### Automated Test Suite

Run the comprehensive test suite:

```bash
# Set environment variables
export API_BASE_URL=http://localhost:4006
export AXISROOMS_API_KEY=your-api-key

# Run tests
npx ts-node test-axisrooms-endpoints.ts
```

The test suite covers:
- ✅ Authentication validation (invalid/missing keys)
- ✅ Property validation (invalid propertyId)
- ✅ Product info retrieval
- ✅ Rate plan info retrieval
- ✅ Inventory updates (upsert logic)
- ✅ Rate updates with dynamic occupancy
- ✅ Restriction updates (all types: Status, COA, COD, MLos)

### Manual Testing with cURL

#### Test ProductInfo
```bash
curl -X POST http://localhost:4006/api/v1/axisrooms/productInfo \
  -H "Content-Type: application/json" \
  -d '{
    "auth": {"key": "your-api-key"},
    "propertyId": "AX_TEST_HOTEL_1"
  }'
```

#### Test InventoryUpdate
```bash
curl -X POST http://localhost:4006/api/v1/axisrooms/inventoryUpdate \
  -H "Content-Type: application/json" \
  -d '{
    "auth": {"key": "your-api-key"},
    "data": {
      "propertyId": "AX_TEST_HOTEL_1",
      "roomId": "DELUXE_ROOM",
      "inventory": [
        {"startDate": "2026-06-01", "endDate": "2026-06-05", "free": 10}
      ]
    }
  }'
```

---

## Postman Collection

Import the Postman collection for quick testing:

**File:** `postman/AxisRooms-CM-OTA.postman_collection.json`

### Collection Variables

Update these variables in Postman:

| Variable | Default | Description |
|----------|---------|-------------|
| `baseUrl` | `http://localhost:3000` | Base URL of your API |
| `apiPrefix` | `/api/v1` | API prefix |
| `apiKey` | `test-key-12345` | AxisRooms API key |
| `propertyId` | `AX_TEST_HOTEL_1` | Test property ID |
| `roomId` | `DELUXE_ROOM` | Test room ID |
| `rateplanId` | `CP_PLAN` | Test rate plan ID |

### Available Requests

1. **Product Info** - Get room list
2. **Rate Plan Info** - Get rate plans
3. **Inventory Update** - Push inventory
4. **Rate Update** - Push rates
5. **Restriction Update** - Status, COA, COD, MLos examples
6. **Test Invalid Auth** - Error handling test
7. **Test Invalid PropertyId** - Validation test

---

## Troubleshooting

### Issue: 401 Unauthorized

**Cause:** Invalid or missing API key

**Solution:**
1. Check `AXISROOMS_API_KEY` in `.env` file
2. Ensure request body contains `auth.key`
3. Verify key matches exactly (case-sensitive)

### Issue: "Invalid propertyId" Response

**Cause:** Property not mapped or not enabled

**Solution:**
```sql
-- Check if property exists
SELECT * FROM tbo_hotel_master 
WHERE axisrooms_property_id = 'AX_TEST_HOTEL_1';

-- Enable property
UPDATE tbo_hotel_master 
SET axisrooms_enabled = 1 
WHERE axisrooms_property_id = 'AX_TEST_HOTEL_1';
```

### Issue: Database Schema Mismatch

**Cause:** Prisma schema not synced to database

**Solution:**
```bash
# Force push schema changes
npx prisma db push --force-reset

# Regenerate client
npx prisma generate
```

### Issue: Test Data Not Found

**Cause:** Seed script not run

**Solution:**
```bash
# Run seed script
npx ts-node seed-axisrooms-test-data.ts
```

### Issue: Rate Update with Dynamic Occupancy Fails

**Cause:** Occupancy keys not extracted properly

**Check:** Ensure `startDate` and `endDate` are present in rate entries. All other keys are treated as occupancy types.

**Example:**
```json
{
  "startDate": "2026-06-01",
  "endDate": "2026-06-05",
  "SINGLE": 5000,      // ← These are occupancy rates
  "DOUBLE": 6000,      // ← 
  "CUSTOM_KEY": 7000   // ← Any key is valid
}
```

---

## Logs and Debugging

### Inbound Request Logs

All requests are logged in `axisrooms_inbound_log` table:

```sql
-- View recent logs
SELECT * FROM axisrooms_inbound_log 
ORDER BY received_at DESC 
LIMIT 20;

-- View logs by type
SELECT * FROM axisrooms_inbound_log 
WHERE type = 'inventoryUpdate' 
ORDER BY received_at DESC;
```

### Application Logs

Enable detailed logging:

```env
ENABLE_LOG=1
PRISMA_LOG_QUERIES=1
```

---

## Production Deployment Checklist

- [ ] Update `AXISROOMS_API_KEY` with production key
- [ ] Map production hotels in `tbo_hotel_master`
- [ ] Set `axisrooms_enabled = 1` for mapped hotels
- [ ] Test all endpoints with production data
- [ ] Monitor `axisrooms_inbound_log` for errors
- [ ] Set up alerts for 401/failure responses
- [ ] Document AxisRooms clientUrl for production
- [ ] Share production endpoints with AxisRooms team

---

## Support

For issues or questions:
1. Check `axisrooms_inbound_log` table for request details
2. Review application logs
3. Verify property mapping and enabled status
4. Refer to this documentation

---

## Summary

✅ **Endpoints:** 5 endpoints under `/api/v1/axisrooms/*`  
✅ **Database:** 6 new tables + 2 fields in `tbo_hotel_master`  
✅ **Authentication:** Body-based API key validation  
✅ **Testing:** Automated test suite + Postman collection  
✅ **Logging:** All requests logged for debugging  
✅ **Documentation:** Complete API specs and setup guide  

**Next Steps:**
1. Share clientUrl with AxisRooms: `https://your-domain.com/api/v1/axisrooms/*`
2. AxisRooms team will configure push endpoints
3. Later, AxisRooms will share Push Booking API details
