# Hotel State Fix Scripts

These scripts use raw MySQL via `mysql2/promise` and load env from `.env` with `dotenv`.

`mysql2` and `dotenv` are already present in this backend project. If you need to install them again:

```bash
npm install mysql2 dotenv
```

Default env behavior:

- `DRY_RUN=true` by default
- `BAD_STATE_ID=4222`
- `LIMIT=5000`
- `API_DELAY_MS=250`
- `ONLY_PINCODE=` optional
- `ONLY_HOTEL_ID=` optional

City geocode fallback env behavior:

- `DRY_RUN=true` by default
- `BAD_STATE_ID=4222`
- `LIMIT=200`
- `GEOCODE_DELAY_MS=1200`
- `ONLY_CITY_ID=` optional
- `ONLY_HOTEL_ID=` optional
- `ONLY_CITY_NAME=` optional
- `NOMINATIM_USER_AGENT=DVI-Hotel-State-Cleanup/1.0 (contact: kiran.phpfish@gmail.com)`

Audit:

```bash
node scripts/audit-hotel-geo-mismatches.js
```

Dry run:

```bash
DRY_RUN=true LIMIT=5000 node scripts/fix-hotel-state-by-pincode.js
```

Test one pincode:

```bash
DRY_RUN=true ONLY_PINCODE=307501 node scripts/fix-hotel-state-by-pincode.js
```

Apply:

```bash
DRY_RUN=false LIMIT=5000 node scripts/fix-hotel-state-by-pincode.js
```

Verify:

```bash
node scripts/verify-hotel-state-fix.js
```

Windows Git Bash compatible example:

```bash
DRY_RUN=true LIMIT=5000 node scripts/fix-hotel-state-by-pincode.js
```

PowerShell compatible example:

```powershell
$env:DRY_RUN="true"; $env:LIMIT="5000"; node scripts/fix-hotel-state-by-pincode.js
```

Safety notes:

- The fix script defaults to dry-run and will not update hotel or city rows unless `DRY_RUN=false`.
- City rows are only updated when one and only one state wins the vote for that `city_id`.
- Real apply mode creates backup tables before updates:
  - `dvi_hotel_4222_backup_before_pincode_fix`
  - `dvi_cities_4222_backup_before_pincode_fix`
- Logging goes to `dvi_hotel_pincode_state_fix_log`.

## City Geocode Fallback

This pass is a safer fallback for rows that were not fixed by pincode cleanup because the pincode is invalid, malformed, or returned no records.
It uses Nominatim/OpenStreetMap with a custom `User-Agent`, throttled requests, and a dry-run default.

Dry run one city:

```bash
DRY_RUN=true ONLY_CITY_NAME=Abu Road LIMIT=50 node scripts/fix-hotel-state-by-city-geocode.js
```

Dry run small batch:

```bash
DRY_RUN=true LIMIT=100 node scripts/fix-hotel-state-by-city-geocode.js
```

Apply small batch:

```bash
DRY_RUN=false LIMIT=100 node scripts/fix-hotel-state-by-city-geocode.js
```

Verify:

```bash
node scripts/verify-hotel-state-fix.js
```

PowerShell:

```powershell
$env:DRY_RUN="true"; $env:LIMIT="100"; node scripts/fix-hotel-state-by-city-geocode.js
```

Validation:

```bash
node --check scripts/fix-hotel-state-by-city-geocode.js
```

Dry-run test:

```bash
DRY_RUN=true LIMIT=20 node scripts/fix-hotel-state-by-city-geocode.js
```

Safety notes:

- The new script defaults to dry-run and will not update hotel or city rows unless `DRY_RUN=false`.
- Hotel name geocoding is only used as corroboration, not as the sole source of truth.
- City rows are only updated when one and only one state wins for that `city_id`.
- Real apply mode creates backup tables before updates:
  - `dvi_hotel_4222_backup_before_city_geocode_fix`
  - `dvi_cities_4222_backup_before_city_geocode_fix`
- Logging goes to `dvi_hotel_city_geocode_fix_log`.
