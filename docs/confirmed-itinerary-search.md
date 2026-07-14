# Confirmed Itinerary Search

This document describes how search works on the legacy page:

`http://localhost/dvi_b2b/latestconfirmeditinerary.php`

It is intended as an implementation reference for the NestJS API and React UI.

## Source flow

The page does not render the itinerary table directly.

1. `latestconfirmeditinerary.php` loads the list fragment with a POST request to `engine/ajax/ajax_confirmed_itinerary_list.php?type=show_form`.
2. `ajax_confirmed_itinerary_list.php` renders the filter controls and the `#itinerary_LIST` table.
3. The inline DataTables configuration initializes the table with `serverSide: true`.
4. DataTables sends the search text to `engine/json/__JSONconfirmed_itinerary.php`.
5. The JSON endpoint reads `search[value]` and passes it to the MySQL procedure `GetConfirmedItineraryPlans`.
6. The procedure adds an SQL `LIKE` condition across the searchable fields.

Relevant legacy files:

- `C:\wamp64\www\dvi_b2b\latestconfirmeditinerary.php`
- `C:\wamp64\www\dvi_b2b\engine\ajax\ajax_confirmed_itinerary_list.php`
- `C:\wamp64\www\dvi_b2b\engine\json\__JSONconfirmed_itinerary.php`
- `C:\wamp64\www\dvi_b2b\GetConfirmedItineraryPlans.local.sql`

## What the user sees

The search box is DataTables’ standard global search box. There is no custom search input or custom `keyup` handler in this page.

It is enabled by:

```javascript
{
  dom: 'Blfrtip',
  bFilter: true,
  serverSide: true,
  processing: true
}
```

When the user types a value, DataTables sends a new GET request. Depending on the DataTables version and configuration, the request also contains column metadata and ordering fields, but the backend only uses these important values:

| Parameter | Meaning |
|---|---|
| `draw` | DataTables request sequence number |
| `start` | Zero-based row offset |
| `length` | Page size |
| `search[value]` | Global search text |
| `search[regex]` | Sent by DataTables but not used by the PHP backend |
| `source_location` | Exact arrival-location filter |
| `destination_location` | Exact departure-location filter |
| `start_date` | Exact trip start date |
| `end_date` | Exact trip end date |
| `agent_id` | Agent filter |
| `staff_id` | Agent staff/travel expert filter |
| `guide_id` | Guide filter |
| `vendor_id` | Vendor filter |
| `cnfi_list_filter=1` | Include only cancelled itineraries |

Example search request:

```http
GET /dvi_b2b/engine/json/__JSONconfirmed_itinerary.php
    ?draw=4
    &start=0
    &length=10
    &search[value]=Bangalore
    &search[regex]=false
    &source_location=
    &destination_location=
```

The React application can use the simpler equivalent:

```http
GET /confirmed-itineraries?search=Bangalore&page=1&pageSize=10
```

The legacy DataTables parameter names only need to be preserved if the React table component still expects a DataTables-compatible API.

## Search fields

The stored procedure searches the supplied text as a substring using one `LIKE` expression per field. The conditions are combined with `OR`:

```sql
AND (
    dip.arrival_location LIKE '%search%'
    OR dip.departure_location LIKE '%search%'
    OR s.staff_name LIKE '%search%'
    OR a.agent_name LIKE '%search%'
    OR dip.itinerary_quote_ID LIKE '%search%'
    OR ipd.itinerary_quote_ID LIKE '%search%'
    OR du.username LIKE '%search%'
)
```

The searchable fields are:

| User-visible meaning | Database field |
|---|---|
| Arrival/origin | `dip.arrival_location` |
| Departure/destination | `dip.departure_location` |
| Staff/travel-expert name | `s.staff_name` |
| Agent name | `a.agent_name` |
| Booking ID | `dip.itinerary_quote_ID` |
| Quote ID | `ipd.itinerary_quote_ID` |
| Created-by username | `du.username` |

Search is partial. For example, `Bangalore` matches a location containing `Bangalore`, and a partial booking ID can also match. Search does not currently search the primary customer, dates, number of people, payment balance, or itinerary preference.

Whether matching is case-sensitive is determined by the MySQL column collation. The React/Nest implementation should choose and document a deliberate policy, preferably case-insensitive matching for the current user experience.

An empty or missing `search[value]` means that no global search predicate is added.

## Other predicates applied with search

The global search is combined with the normal itinerary restrictions. The procedure always starts with:

```sql
dip.deleted = 0
AND ipd.deleted = 0
```

Additional filters are appended when present:

- `cnfi_list_filter = 1`: itinerary must exist in `dvi_cancelled_itineraries` with `status = 1` and `deleted = 0`.
- `start_date`: `DATE(dip.trip_start_date_and_time) = start_date`.
- `end_date`: `DATE(dip.trip_end_date_and_time) = end_date`.
- `source_location`: exact equality with `dip.arrival_location`.
- `destination_location`: exact equality with `dip.departure_location`.
- Agent/staff access: restricted according to the logged-in user role and IDs.
- `vendor_id`: itinerary must be assigned to the vendor in `dvi_itinerary_plan_vendor_eligible_list` with assignment status `1`.
- `guide_id`: itinerary must have an active route guide record in `dvi_itinerary_route_guide_details`.

All restrictions are AND-ed with the global search group. For example:

```sql
WHERE dip.deleted = 0
  AND ipd.deleted = 0
  AND DATE(dip.trip_start_date_and_time) = :startDate
  AND (
      dip.arrival_location LIKE :search
      OR dip.departure_location LIKE :search
      OR s.staff_name LIKE :search
      -- other searchable fields
  )
```

## Pagination and response

The procedure uses:

```sql
ORDER BY dip.itinerary_plan_ID DESC
LIMIT :start, :length
```

The endpoint returns the DataTables response shape:

```json
{
  "draw": 4,
  "recordsTotal": 1119,
  "recordsFiltered": 10,
  "data": []
}
```

`data` contains only the current page. Important row fields include:

- `modify`
- `itinerary_booking_ID`
- `itinerary_quote_ID`
- `username`
- `arrival_location`
- `departure_location`
- `trip_start_date_and_time`
- `trip_end_date_and_time`
- `primary_customer`
- `itinerary_total_balance_amount`

## Legacy count problem

The current PHP endpoint does not calculate a proper filtered count for a search.

The count query used for `recordsTotal` does not include the global search predicate. After fetching one page, the endpoint does this when search text exists:

```php
if ($searchValue) {
    $totalRecords = $counter;
}
```

`$counter` is only the number of rows returned on the current page. Therefore, a search with more than one page can report `recordsFiltered = 10` even when many more rows match. The live behavior confirms this: `Bangalore` returns the first 10 rows and reports `recordsFiltered: 10`.

The NestJS API should calculate two separate counts using the same predicates:

```sql
-- Total before global search, but with access and regular filters.
SELECT COUNT(*) FROM base_query_without_search;

-- Total after adding the search predicate.
SELECT COUNT(*) FROM base_query_with_search;
```

Then return:

```json
{
  "draw": 4,
  "recordsTotal": 1119,
  "recordsFiltered": 87,
  "data": [/* maximum pageSize rows */]
}
```

For an empty search, `recordsFiltered` should equal `recordsTotal`.

## Legacy parameter inconsistencies

The filter change handlers rebuild the endpoint URL manually. Most handlers use these names:

```text
guide_select
vendor_select
```

However, `__JSONconfirmed_itinerary.php` reads:

```php
$_GET['guide_id']
$_GET['vendor_id']
```

The initial DataTables URL uses `guide_id` and `vendor_id`, but subsequent guide/vendor changes may be ignored because of this naming mismatch. The NestJS/React implementation should use one consistent contract, preferably `guideId` and `vendorId` in the new API.

The date picker displays dates in `d-m-Y` format. The PHP helper converts them to `Y-m-d` before calling MySQL. The new API should accept ISO dates (`YYYY-MM-DD`) and let React format them only for display.

## Recommended NestJS API contract

```typescript
export class ConfirmedItineraryQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 10;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsInt()
  agentId?: number;

  @IsOptional()
  @IsInt()
  staffId?: number;

  @IsOptional()
  @IsInt()
  guideId?: number;

  @IsOptional()
  @IsInt()
  vendorId?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  includeCancelled?: boolean;
}
```

Recommended response:

```typescript
type ConfirmedItineraryListResponse = {
  page: number;
  pageSize: number;
  total: number;
  filteredTotal: number;
  items: ConfirmedItinerary[];
};
```

If the React table is DataTables-compatible, map the names at the controller boundary:

```typescript
return {
  draw: Number(query.draw ?? 0),
  recordsTotal: result.total,
  recordsFiltered: result.filteredTotal,
  data: result.items,
};
```

## Recommended NestJS query implementation

Build one reusable, parameterized base query. Use it for the page query and both count queries so the predicates cannot drift apart.

```typescript
const normalizedSearch = query.search?.trim() ?? '';
const searchPattern = `%${escapeLike(normalizedSearch)}%`;

const qb = repository
  .createQueryBuilder('dip')
  .innerJoin('dvi_itinerary_plan_details', 'ipd', 'ipd.itinerary_plan_ID = dip.itinerary_plan_ID')
  .innerJoin('dvi_users', 'du', 'du.userID = dip.createdby')
  .leftJoin('dvi_staff_details', 's', 's.staff_id = du.staff_id')
  .leftJoin('dvi_agent', 'a', 'a.agent_ID = du.agent_id')
  .where('dip.deleted = :notDeleted', { notDeleted: 0 })
  .andWhere('ipd.deleted = :notDeleted', { notDeleted: 0 });

if (normalizedSearch !== '') {
  qb.andWhere(new Brackets((searchQb) => {
    searchQb
      .where('dip.arrival_location LIKE :search ESCAPE \'\\\'', { search: searchPattern })
      .orWhere('dip.departure_location LIKE :search ESCAPE \'\\\'', { search: searchPattern })
      .orWhere('s.staff_name LIKE :search ESCAPE \'\\\'', { search: searchPattern })
      .orWhere('a.agent_name LIKE :search ESCAPE \'\\\'', { search: searchPattern })
      .orWhere('dip.itinerary_quote_ID LIKE :search ESCAPE \'\\\'', { search: searchPattern })
      .orWhere('ipd.itinerary_quote_ID LIKE :search ESCAPE \'\\\'', { search: searchPattern })
      .orWhere('du.username LIKE :search ESCAPE \'\\\'', { search: searchPattern });
  }));
}

const filteredTotal = await countFromSameQuery(qb);
const items = await qb
  .orderBy('dip.itinerary_plan_ID', 'DESC')
  .skip((query.page - 1) * query.pageSize)
  .take(query.pageSize)
  .getRawMany();
```

Do not concatenate `search`, locations, or dates directly into SQL. The legacy procedure does this, but the NestJS API should use query parameters and should escape `%`, `_`, and the escape character when implementing substring search.

## Recommended React behavior

1. Keep `search`, filters, `page`, and `pageSize` in component state or the URL query string.
2. Debounce search input by approximately 250–400 ms.
3. Reset `page` to `1` when search text or any filter changes.
4. Send the current search and filter values in one request.
5. Render `filteredTotal` for the current result set.
6. Cancel or ignore stale requests when the user types quickly.
7. Use ISO dates in requests and display localized dates only in the table.

Example request state:

```typescript
const params = {
  search: search.trim() || undefined,
  page,
  pageSize,
  startDate: startDate || undefined,
  endDate: endDate || undefined,
  agentId: agentId || undefined,
  staffId: staffId || undefined,
  guideId: guideId || undefined,
  vendorId: vendorId || undefined,
  includeCancelled,
};
```

## Summary

The legacy search is a server-side, global, partial-text search. The browser sends `search[value]`; the API forwards it to the stored procedure; the procedure matches it against arrival, departure, staff name, agent name, booking ID, quote ID, and username. It is combined with access, date, location, vendor, guide, and cancelled-itinerary filters.

For the NestJS/React version, preserve the seven searchable fields and AND/OR semantics, but use a clean typed query contract, parameterized SQL, shared predicates for counts and data, and a correct filtered count.
