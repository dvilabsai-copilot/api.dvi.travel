import assert from 'node:assert/strict';
import test from 'node:test';
import { getNormalizedMealPlanLabelFromMealSources } from '../src/modules/hotels/hotel-rate-plans';

test('maps TBO inclusions to canonical meal plans before MealType fallback', () => {
  assert.equal(
    getNormalizedMealPlanLabelFromMealSources(
      'BREAKFAST AND  DINNER,COMPLIMENTARY WIFI,DINNER',
      'Room_Only',
    ),
    'MAP',
  );
  assert.equal(
    getNormalizedMealPlanLabelFromMealSources('Breakfast &amp; Lunch/Dinner', 'Half_Board'),
    'MAP',
  );
  assert.equal(
    getNormalizedMealPlanLabelFromMealSources('Breakfast, Lunch &amp; Dinner', 'Full_Board'),
    'AP',
  );
  assert.equal(
    getNormalizedMealPlanLabelFromMealSources('BREAKFAST ONLY', 'BreakFast'),
    'CP',
  );
});

test('falls back to TBO MealType when inclusion has no meal information', () => {
  assert.equal(
    getNormalizedMealPlanLabelFromMealSources('Parking and Wi-Fi included', 'Room_Only'),
    'EP',
  );
  assert.equal(
    getNormalizedMealPlanLabelFromMealSources('', 'Half_Board'),
    'MAP',
  );
});
