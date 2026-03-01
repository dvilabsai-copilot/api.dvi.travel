# AxisRooms Integration - Quick Start Guide

## 🎯 What Was Implemented

Complete AxisRooms Channel Manager integration with:
- ✅ 5 REST API endpoints under `/api/v1/axisrooms/*`
- ✅ 6 new database tables for inventory, rates, restrictions
- ✅ Hotel mapping in `dvi_hotel` master table
- ✅ Body-based API key authentication
- ✅ Comprehensive test suite
- ✅ Postman collection
- ✅ Full documentation

---

## 📁 Files Created/Modified

### Prisma Schema
- ✅ `prisma/schema.prisma` - Added 2 fields to `dvi_hotel` + 6 new models

### NestJS Module Structure
```
src/modules/axisrooms/
├── dto/
│   ├── auth.dto.ts
│   ├── product-info.dto.ts
│   ├── rate-plan-info.dto.ts
│   ├── inventory-update.dto.ts
│   ├── rate-update.dto.ts
│   └── restriction-update.dto.ts
├── guards/
│   └── axisrooms-api-key.guard.ts
├── axisrooms.controller.ts
├── axisrooms.service.ts
└── axisrooms.module.ts
```

### App Integration
- ✅ `src/app.module.ts` - Imported AxisRoomsModule

### Testing & Tools
- ✅ `seed-axisrooms-test-data.ts` - Seeds test hotel + rooms + rate plans
- ✅ `test-axisrooms-endpoints.ts` - Comprehensive test suite

### Postman
- ✅ `postman/AxisRooms-CM-OTA.postman_collection.json` - 9 test requests

### Documentation
- ✅ `AXISROOMS_INTEGRATION.md` - Complete integration guide
- ✅ `.env` - Added `AXISROOMS_API_KEY`

---

## 🚀 Setup Commands (Run in Order)

### 1️⃣ Ensure Database is Running
```bash
# Start WAMP/MySQL service
# Verify database is accessible at localhost:3306
```

### 2️⃣ Install Dependencies (if needed)
```bash
npm install
```

### 3️⃣ Apply Database Schema
```bash
# Push schema changes to database (NO MIGRATIONS - as required)
npx prisma db push

# Generate Prisma client with new models
npx prisma generate
```

### 4️⃣ Configure Environment
Edit `.env` file:
```env
# AxisRooms CM-OTA Configuration
AXISROOMS_API_KEY=your-axisrooms-api-key-here
```

### 5️⃣ Seed Test Data
```bash
# Creates test hotel with propertyId: AX_TEST_1
npx ts-node seed-axisrooms-test-data.ts
```

### 6️⃣ Start Server
```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

### 7️⃣ Run Tests
```bash
# Set environment variables
$env:API_BASE_URL="http://localhost:4006"
$env:AXISROOMS_API_KEY="your-api-key"

# Run test suite
npx ts-node test-axisrooms-endpoints.ts
```

---

## 🧪 Quick Test

Once server is running, test with PowerShell:

```powershell
$body = @{
    auth = @{ key = "your-api-key" }
    propertyId = "AX_TEST_1"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:4006/api/v1/axisrooms/productInfo" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body
```

Expected output:
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

## 📋 API Endpoints Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/axisrooms/productInfo` | POST | Get room list |
| `/api/v1/axisrooms/ratePlanInfo` | POST | Get rate plans |
| `/api/v1/axisrooms/inventoryUpdate` | POST | Receive inventory updates |
| `/api/v1/axisrooms/rateUpdate` | POST | Receive rate updates |
| `/api/v1/axisrooms/restrictionUpdate` | POST | Receive restrictions |

All endpoints:
- ✅ Require `auth.key` in request body
- ✅ Validate `propertyId` mapping in `tbo_hotel_master`
- ✅ Return JSON with `status` field (success/failure)
- ✅ Log all requests to `axisrooms_inbound_log` table

---

## 🗄️ Database Tables Added

1. **`axisrooms_room`** - Room types (productInfo)
2. **`axisrooms_rateplan`** - Rate plans (ratePlanInfo)
3. **`axisrooms_inventory`** - Inventory updates (push)
4. **`axisrooms_rate`** - Rate updates with dynamic occupancy (push)
5. **`axisrooms_restriction`** - Restrictions: Status, COA, COD, MLos (push)
6. **`axisrooms_inbound_log`** - Request logging for debugging

**Updated:**
- `tbo_hotel_master` - Added `axisrooms_property_id` and `axisrooms_enabled`

---

## 🔧 Troubleshooting

### TypeScript Errors?
Run: `npx prisma generate`

### Database Connection Failed?
- Start WAMP/MySQL service
- Verify `.env` DATABASE_URL is correct

### "Invalid propertyId" Response?
Run seed script or manually map a hotel:
```sql
UPDATE tbo_hotel_master 
SET axisrooms_property_id = 'YOUR_PROPERTY_ID', 
    axisrooms_enabled = 1 
WHERE id = <hotel_id>;
```

### 401 Unauthorized?
- Check `AXISROOMS_API_KEY` in `.env`
- Ensure request includes `auth.key` in body

---

## 📖 Full Documentation

See `AXISROOMS_INTEGRATION.md` for:
- Complete API specifications
- Database schema details
- Authentication guide
- Production deployment checklist
- Troubleshooting guide

---

## ✅ Pre-Production Checklist

- [ ] Database schema applied: `npx prisma db push`
- [ ] Prisma client generated: `npx prisma generate`
- [ ] Environment variable configured: `AXISROOMS_API_KEY`
- [ ] Test data seeded (dev only)
- [ ] Server starts without errors
- [ ] All test cases pass
- [ ] Postman collection tested
- [ ] Production hotels mapped in `tbo_hotel_master`
- [ ] `axisrooms_enabled = 1` for mapped hotels
- [ ] Production API key configured

---

## 🤝 Share with AxisRooms

Once deployed, share these endpoints with AxisRooms team:

```
Base URL: https://your-production-domain.com
Endpoints:
- POST /api/v1/axisrooms/productInfo
- POST /api/v1/axisrooms/ratePlanInfo
- POST /api/v1/axisrooms/inventoryUpdate
- POST /api/v1/axisrooms/rateUpdate
- POST /api/v1/axisrooms/restrictionUpdate

Authentication: Body-based API key (auth.key)
```

AxisRooms will then:
1. Configure these as clientUrl in their system
2. Start pushing inventory/rate/restriction updates
3. Later share Push Booking API details

---

## 🎉 Summary

**Implementation Complete!**

- 5 endpoints ready to receive AxisRooms push updates
- Hotel mapping strategy preserves existing architecture
- All requests logged for debugging
- Comprehensive tests and documentation provided
- No breaking changes to existing APIs

**Next Step:** Start database → Run setup commands above → Test endpoints
