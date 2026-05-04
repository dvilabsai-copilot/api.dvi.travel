# Guide Module Migration Audit
_Generated after full PHP-to-React/NestJS parity review_

---

## 1. PHP Legacy → React/NestJS Mapping Table

| PHP File | PHP `$_GET['type']` | NestJS Endpoint | React Component |
|---|---|---|---|
| `guide.php` | (HTML template) | — | `GuideFormPage.tsx`, `GuideListPage.tsx` |
| `__ajax_guide_list.php` | `show_form` | `GET /api/v1/guides` | `GuideListPage` DataTable |
| `__ajax_add_guide_form.php` | `basic_info` | `GET /api/v1/guides/:id/form` | Step 1 (Basic Info) |
| `__ajax_manage_guide.php` | `guide_basic_info` | `POST /api/v1/guides` (create) / `PUT /api/v1/guides/:id` (update) | `handleSaveBasicInfo()` |
| `__ajax_manage_guide.php` | `update_guide_status` | `PATCH /api/v1/guides/:id/status` | Toggle switch in GuideListPage |
| `__ajax_manage_guide.php` | `guide_delete` | — (modal) | Delete confirm dialog |
| `__ajax_manage_guide.php` | `confirm_guide_delete` | `DELETE /api/v1/guides/:id` | `GuideAPI.delete()` |
| `__ajax_manage_guide.php` | `guide_pricebook` | `PATCH /api/v1/guides/:id/pricebook` | `handleUpdatePricebook()` Step 2 |
| `__ajax_guide_price_book.php` | `guide_pricebook` | `GET /api/v1/guides/:id/form` (pricebook in payload) | Step 2 Pricebook form |
| `ajax_guide_pricebook_details.php` | `show_form` | `GET /api/v1/guides/:id` (pricebook embedded) | Step 2 current price display |
| `__ajax_guide_feedbackandreview.php` | `guide_feedback` | `POST /api/v1/guides/:id/reviews` / `PUT /api/v1/guides/:id/reviews/:reviewId` | Step 3 Review form |
| `__ajax_manage_guide.php` | `guide_feedback` | same as above | — |
| `__ajax_manage_guide.php` | `confirm_guide_feedback_delete` | `DELETE /api/v1/guides/:id/reviews/:reviewId` | Delete review button |
| `__ajax_guide_preview.php` | `guide_preview` | `GET /api/v1/guides/:id/preview` | Step 4 Preview |
| `__ajax_guide_overallpreview.php` | `overallpreview` | `GET /api/v1/guides/:id/preview` | `GuidePreview.tsx` |
| `__ajax_fetch_state_n_city.php` | state/city cascade | `GET /api/v1/guides/dropdowns/states?countryId=X` + `GET /api/v1/guides/dropdowns/cities?stateId=X` | Country/State/City selects |
| `__ajax_check_guide_email.php` | email-check | `POST /api/v1/guides/ajax/check-guide-email` | (future email blur check) |

---

## 2. Full Endpoint List

### Guide CRUD
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/guides` | List all guides (with optional `q`, `page`, `size`, `status` query params) |
| `POST` | `/api/v1/guides` | Create new guide (Step 1 save) |
| `GET` | `/api/v1/guides/:id` | Get one guide (normalized for edit form) |
| `GET` | `/api/v1/guides/:id/form` | Get guide form data (raw payload + reviews + pricebook) |
| `PUT` | `/api/v1/guides/:id` | Update guide basic info |
| `PATCH` | `/api/v1/guides/:id/status` | Toggle active/inactive |
| `DELETE` | `/api/v1/guides/:id` | Soft-delete guide (also soft-deletes reviews, pricebook, user account) |

### Pricebook
| Method | Path | Description |
|---|---|---|
| `PUT` | `/api/v1/guides/:id/pricebook` | Save/update pricebook (month/day-wise) |
| `PATCH` | `/api/v1/guides/:id/pricebook` | Alias for PUT pricebook |
| `PUT` | `/api/v1/guides/:id/pricebook-and-preview` | Save pricebook + return preview |

### Reviews
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/guides/:id/reviews` | List reviews for guide |
| `POST` | `/api/v1/guides/:id/reviews` | Add new review |
| `PUT` | `/api/v1/guides/:id/reviews/:reviewId` | Update existing review |
| `DELETE` | `/api/v1/guides/:id/reviews/:reviewId` | Soft-delete review |
| `DELETE` | `/api/v1/guides/reviews/:reviewId` | Alias for delete review |

### Preview
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/guides/:id/preview` | Get guide preview with human-readable labels |
| `GET` | `/api/v1/guides/:id/preview-page` | Preview + form options (React Preview page) |
| `GET` | `/api/v1/guides/:id/overallpreview` | Alias for preview-page (PHP compat) |

### Dropdowns
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/guides/dropdowns/roles` | Roles from `dvi_rolemenu` |
| `GET` | `/api/v1/guides/dropdowns/languages` | Languages from `dvi_language` |
| `GET` | `/api/v1/guides/dropdowns/countries` | Countries from `dvi_countries` |
| `GET` | `/api/v1/guides/dropdowns/states?countryId=X` | States (dependent on countryId) |
| `GET` | `/api/v1/guides/dropdowns/cities?stateId=X` | Cities (dependent on stateId) |
| `GET` | `/api/v1/guides/dropdowns/gst-types` | GST type options (Included/Excluded) |
| `GET` | `/api/v1/guides/dropdowns/gst-percentages` | GST% from `dvi_gst_setting` |
| `GET` | `/api/v1/guides/dropdowns/hotspots` | Hotspot places from `dvi_hotspot_place` |
| `GET` | `/api/v1/guides/dropdowns/activities` | Activities from `dvi_activity` |
| `GET` | `/api/v1/guides/options` | All form options in one call |

### PHP AJAX Compatibility Routes
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/guides/ajax/list` | PHP DataTable compat |
| `POST` | `/api/v1/guides/ajax/manage?type=guide_basic_info` | PHP manage compat |
| `POST` | `/api/v1/guides/ajax/manage?type=update_guide_status` | PHP status toggle compat |
| `POST` | `/api/v1/guides/ajax/manage?type=confirm_guide_delete` | PHP delete compat |
| `POST` | `/api/v1/guides/ajax/manage?type=guide_pricebook` | PHP pricebook save compat |
| `POST` | `/api/v1/guides/ajax/manage?type=guide_feedback` | PHP review save compat |
| `POST` | `/api/v1/guides/ajax/manage?type=confirm_guide_feedback_delete` | PHP review delete compat |
| `POST` | `/api/v1/guides/ajax/check-guide-email` | PHP email check compat |
| `POST` | `/api/v1/guides/ajax/preview?type=overallpreview` | PHP overall preview compat |

---

## 3. Validation Matrix

| Field | PHP Rule | NestJS Backend | React Frontend |
|---|---|---|---|
| `guide_name` | Required | ✅ `throw BadRequestException` | ✅ `toast.error` on submit |
| `guide_gender` | Required | ✅ validated via `toNum()` | ✅ toast if empty |
| `guide_primary_mobile_number` | Required, 10-digit pattern | ✅ validated | ✅ toast if empty |
| `guide_email` | Required, email format | ✅ validated | ✅ toast if empty, `type="email"`, readonly on edit |
| `guide_email` duplicate | `data-parsley-checkemail` AJAX check | ✅ `/ajax/check-guide-email` backend endpoint | ⚠️ Not called on blur (future enhancement) |
| `guide_select_role` | Required on create | ✅ validated | ✅ toast if empty |
| `guide_password` | Required on create only | ✅ validated (`!input.id && !password`) | ✅ toast if not edit and empty |
| `language_proficiency` | Required | ✅ validated | ✅ toast if empty |
| `guide_gst` | Required | ✅ validated via `toNum()` | ✅ (GST type + GST% fields shown) |
| `guide_available_slot` | Required | ✅ array length check | ✅ toast if empty array |
| `guide_emergency_mobile_number` | Must NOT equal primary | ✅ equality check | ✅ equality check on submit |
| `guide_confirm_account_number` | Must equal account_number | ✅ equality check | ✅ equality check on submit |
| `hotspotSelect` | Required if hotspotCheckbox=1 | ✅ via preferredFor logic | ✅ toast if hotspot+no places |
| `activitySelect` | Required if activityCheckbox=1 | ✅ via preferredFor logic | ✅ toast if activity+no places |
| Pricebook `guide_id` | Required | ✅ | N/A (auto from route param) |
| Pricebook `selectstartdate` | Required | ✅ | ✅ date required check |
| Pricebook `selectenddate` | Required | ✅ | ✅ date required check + end>=start |
| Review `guide_rating` | Required | ✅ | ✅ toast if 0 |
| Review `review_description` | Required | ✅ | ✅ toast if empty |

---

## 4. Pricebook Data Model (PHP → NestJS)

**PHP DB Table:** `dvi_guide_pricebook`
- `guide_price_book_ID` (PK)
- `guide_id` (FK to dvi_guide_details)
- `year` (varchar, e.g., "2026")
- `month` (varchar, e.g., "May")
- `pax_count` (1=1–5 pax, 2=6–14 pax, 3=15–40 pax)
- `slot_type` (1=9AM–1PM, 2=9AM–4PM, 3=6PM–9PM)
- `day_1` through `day_31` (nullable decimal, price per day)
- `status`, `deleted`, `createdby`, `createdon`, `updatedon`

**PHP Save Logic:**
- Loop each month from startDate to endDate
- For each pax × slot combination: upsert (update existing or insert new row)
- Set `day_X` columns for the date range within that month

**NestJS Implementation:** ✅ Exact parity in `savePricebook()`:
- Iterates months with UTC date math
- Upserts by `(guide_id, year, month, pax_count, slot_type)`
- Sets `day_N` columns for the range
- Cleans up duplicate rows

---

## 5. Preferred For Logic

| PHP Checkbox | PHP `guide_preffered_for` value | Associated field | NestJS | React UI |
|---|---|---|---|---|
| `hotspotCheckbox=1` | `1` | `applicable_hotspot_places` (CSV of hotspot IDs) | ✅ | Hotspot checkbox + multi-select |
| `activityCheckbox=1` | `2` | `applicable_activity_places` (CSV of activity IDs) | ✅ | Activity checkbox + multi-select |
| `itineraryCheckbox=1` | `3` | none required | ✅ | Itinerary checkbox |

---

## 6. React UI Steps vs PHP Stepper

| Step | PHP formtype | React `currentStep` | Route |
|---|---|---|---|
| 1 | `basic_info` | 1 | `/guide/new` or `/guide/:id/edit` |
| 2 | `guide_pricebook` | 2 | same page, step toggle |
| 3 | `guide_feedback` | 3 | same page, step toggle |
| 4 | `guide_preview` | 4 | same page, step toggle |
| Overall Preview | `overallpreview` | separate page | `/guide/:id/preview` |

---

## 7. Database Tables Used

| Table | Used For |
|---|---|
| `dvi_guide_details` | Guide master record |
| `dvi_users` | User account linked to guide (username = primary mobile, role) |
| `dvi_guide_pricebook` | Month/day-wise pricebook |
| `dvi_guide_review_details` | Feedback & Reviews |
| `dvi_rolemenu` | Role dropdown |
| `dvi_language` | Language proficiency dropdown |
| `dvi_countries` | Country dropdown |
| `dvi_states` | State dropdown (filtered by country_id) |
| `dvi_cities` | City dropdown (filtered by state_id) |
| `dvi_gst_setting` | GST% dropdown |
| `dvi_hotspot_place` | Hotspot places multi-select |
| `dvi_activity` | Activity places multi-select |

---

## 8. Live Smoke Test Results (26 Apr 2026)

| Test | Status | Result |
|---|---|---|
| Backend build | ✅ PASS | `tsc -p tsconfig.json` — no errors |
| Frontend build | ✅ PASS | `vite build` — 3370 modules, no errors |
| `GET /api/v1/guides` (auth) | ✅ PASS | Returns `{ data: [...] }` with 3 guides |
| `GET /api/v1/guides/dropdowns/roles` | ✅ PASS | 8 roles |
| `GET /api/v1/guides/dropdowns/languages` | ✅ PASS | 7 languages |
| `GET /api/v1/guides/dropdowns/countries` | ✅ PASS | 246 countries |
| `GET /api/v1/guides/dropdowns/states?countryId=101` | ✅ PASS | 57 Indian states |
| `GET /api/v1/guides/dropdowns/cities?stateId=4030` | ✅ PASS | 3 cities |
| `GET /api/v1/guides/dropdowns/gst-percentages` | ✅ PASS | 4 GST% options |
| `GET /api/v1/guides/dropdowns/hotspots` | ✅ PASS | 774 hotspots |
| `GET /api/v1/guides/dropdowns/activities` | ✅ PASS | 133 activities |
| `GET /api/v1/guides/:id` (edit form) | ✅ PASS | Returns name, email, role, slots |
| `GET /api/v1/guides/:id/preview` | ✅ PASS | Returns label-resolved preview (state_name, language_label) |
| Auth guard | ✅ PASS | 401 without token |

---

## 9. Remaining Gaps / Future Enhancements

| Priority | Gap | Description |
|---|---|---|
| Low | Email duplicate async check on blur | PHP used `data-parsley-checkemail` on field blur. React validates only on submit. Can add `onBlur` to email field calling `/ajax/check-guide-email`. |
| Low | Aadhar 12-digit pattern in React | PHP enforces `^\d{12}$` pattern. React has no format validation on Aadhar field. |
| Low | Mobile 10-digit pattern in React | PHP enforces `^\d{10}$`. React has no length/pattern check. |
| Low | Guide `gst_type` required validation | PHP requires `gst_type`. NestJS validates `guide_gst` amount but not `gst_type` presence. |
| Enhancement | Pricebook display after save | PHP reloads pricebook table after submitting. React could show a summary table of saved prices after step 2. |
| Enhancement | Guide export CSV in preview | PHP overall preview had review list table. React `GuidePreview.tsx` shows basic info + bank + preferred_for + reviews which matches. |

---

## 10. Deployment Status

| Environment | Status | Deployed By |
|---|---|---|
| Backend (api.dvi.travel) | ✅ Live — commit `c4734a0` on `main` | GitHub Actions → DO SSH deploy |
| Frontend (dvi.travel) | ✅ Live — commit `b16687a` on `main` | GitHub Actions → DO SCP deploy |

_All guide module code is committed, PR-merged to `main`, and deployed to production via CI/CD._
