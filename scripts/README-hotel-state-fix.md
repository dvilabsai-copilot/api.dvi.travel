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

## Sri Lanka Hotel and City State Fix

This pass is specific to Sri Lanka where provinces still map into `dvi_states`.
It geocodes at the city level and defaults to throttled Nominatim/OpenStreetMap requests with a custom `User-Agent`.
Google is disabled unless `GEOCODE_PROVIDER=google` is explicitly set and a non-empty `GOOGLE_MAPS_API_KEY` is available.

Recommended env:

- `SRI_LANKA_COUNTRY_ID=206`
- `BAD_SRI_LANKA_STATE_ID=4327`
- `GEOCODE_PROVIDER=nominatim`
- `DRY_RUN=true`
- `LIMIT=100`
- `GEOCODE_DELAY_MS=1200`
- `ONLY_CITY_ID=` optional
- `ONLY_CITY_NAME=` optional
- `ONLY_HOTEL_ID=` optional
- `GOOGLE_MAPS_API_KEY=`
- `NOMINATIM_USER_AGENT=DVI-SriLanka-State-Cleanup/1.0 (contact: kiran.phpfish@gmail.com)`

Verify before fix:

```bash
node scripts/verify-srilanka-hotel-city-states.js
```

Dry run small batch:

```bash
DRY_RUN=true LIMIT=20 node scripts/fix-srilanka-hotel-city-states.js
```

Dry run with explicit Nominatim provider:

```bash
GEOCODE_PROVIDER=nominatim DRY_RUN=true LIMIT=20 node scripts/fix-srilanka-hotel-city-states.js
```

Dry run one city:

```bash
DRY_RUN=true ONLY_CITY_NAME=Colombo LIMIT=10 node scripts/fix-srilanka-hotel-city-states.js
```

Apply small batch:

```bash
DRY_RUN=false LIMIT=20 node scripts/fix-srilanka-hotel-city-states.js
```

Verify after fix:

```bash
node scripts/verify-srilanka-hotel-city-states.js
```

PowerShell:

```powershell
$env:DRY_RUN="true"; $env:LIMIT="20"; node scripts/fix-srilanka-hotel-city-states.js
$env:GEOCODE_PROVIDER="nominatim"; $env:DRY_RUN="true"; $env:LIMIT="20"; node scripts/fix-srilanka-hotel-city-states.js
$env:DRY_RUN="true"; $env:ONLY_CITY_NAME="Colombo"; $env:LIMIT="10"; node scripts/fix-srilanka-hotel-city-states.js
```

Validation:

```bash
node --check scripts/fix-srilanka-hotel-city-states.js
node --check scripts/verify-srilanka-hotel-city-states.js
```

Dry-run sequence:

```bash
node scripts/verify-srilanka-hotel-city-states.js
DRY_RUN=true LIMIT=20 node scripts/fix-srilanka-hotel-city-states.js
```

Real-mode safety notes:

- The Sri Lanka script defaults to dry-run and will not make real DB updates unless `DRY_RUN=false`.
- The Sri Lanka script defaults to `GEOCODE_PROVIDER=nominatim`.
- Google is only used when `GEOCODE_PROVIDER=google` and `GOOGLE_MAPS_API_KEY` is non-empty.
- Real mode creates backup tables before updates:
  - `dvi_hotel_srilanka_state_4327_backup`
  - `dvi_cities_srilanka_state_4327_backup`
- Logging goes to `dvi_srilanka_geo_state_fix_log`.
- The script does not delete or merge duplicate states automatically.
