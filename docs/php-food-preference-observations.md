# PHP Food Preference Observations

## Scope

These observations are based on the active PHP application located at:

`../../dvi_b2b` relative to the API repository.

Relevant files:

- `engine/ajax/ajax_latest_itineary_step1_form.php`
- `engine/ajax/ajax_latest_manage_itineary.php`
- `controller/core/sql_functions.php`
- `agent_voucherpdf.php`

## Food preference values

The `getFOODTYPE()` function defines the following values:

| Value | Label |
|---:|---|
| `1` | Vegetarian |
| `2` | Non Vegetarian |
| `3` | Both |

Defined in `controller/core/sql_functions.php` around lines 6201-6218.

## When the field is displayed

The Food Preferences field is displayed when the itinerary includes hotels:

| Itinerary preference | Meaning | Food preference |
|---:|---|---|
| `1` | Hotel | Shown |
| `2` | Vehicle | Hidden |
| `3` | Both Hotel and Vehicle | Shown |

The PHP form hides the field when `itinerary_preference == 2`. The JavaScript also removes the Food Preference and Meal Plan controls when Vehicle-only is selected, and recreates them when Hotel or Both is selected.

This behavior is implemented in `engine/ajax/ajax_latest_itineary_step1_form.php` around lines 62-69, 474-496, and 2213-2280.

## What happens during itinerary creation

### Hotel or Both

When room data is present:

1. `food_type` is read from `$_POST['food_type']`.
2. It is stored in `dvi_itinerary_plan_details.food_type`.
3. The meal-plan checkboxes are stored independently:
   - `meal_plan_breakfast`
   - `meal_plan_lunch`
   - `meal_plan_dinner`

The save/update logic is in `engine/ajax/ajax_latest_manage_itineary.php` around lines 228-278.

### Vehicle-only

Vehicle-only itineraries do not contain room data. In that case the backend sets:

```php
$food_type = 0;
```

The meal-plan fields are also normally `0` because the controls are removed from the form. Therefore, Vehicle-only itineraries do not retain a meaningful food preference.

## Effect on hotel generation and pricing

Food Preference and Meal Plan have different purposes:

- `food_type` describes the guest's dietary preference.
- Meal-plan flags control whether breakfast, lunch, and dinner are included and charged.

Hotel generation runs only for itinerary preferences `1` and `3`.

The hotel pricing code uses the meal-plan flags and the hotel meal costs to calculate the total breakfast, lunch, dinner, tax, and hotel amount. It does not use `food_type` to filter hotels, select room rates, or calculate meal prices.

Relevant logic is in `engine/ajax/ajax_latest_manage_itineary.php` around lines 6409-6418 and 7088-7108.

## Confirmation and voucher output

When the quotation is confirmed, `food_type` is copied into `dvi_confirmed_itinerary_plan_details` together with the meal-plan flags. This occurs in `engine/ajax/ajax_latest_manage_itineary.php` around lines 30806-30808.

The hotel voucher reads the confirmed `food_type` and displays the dietary label alongside the meal plan. This occurs in `agent_voucherpdf.php` around lines 138-178 and 342-343.

## Identified issue

The voucher mapping handles values `1` and `2` explicitly, but sends every other value, including `3` (`Both`), to the Non-Vegetarian label:

```php
if ($food_type == 1) {
    $food_type_format = 'Vegetarian';
} elseif ($food_type == 2) {
    $food_type_format = 'Non-Vegetarian';
} else {
    $food_type_format = 'Non-Vegetarian';
}
```

As a result, selecting `Both` in the itinerary form may be shown as `Non-Vegetarian` in the hotel voucher. The voucher should explicitly handle value `3` as `Both`.

## Conclusion

The current behavior is intentional from the PHP form's perspective: food preference is treated as a hotel-related guest preference, so it is not shown for Vehicle-only itineraries.

Selecting Vegetarian, Non Vegetarian, or Both for Hotel/Both itineraries stores the value and displays it later, but it does not affect hotel search or pricing. Meal-plan selections are the values that affect hotel meal charges.
