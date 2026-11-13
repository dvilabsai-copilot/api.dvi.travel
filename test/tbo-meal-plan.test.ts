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

test('does not count a separately payable gala dinner as an included meal', () => {
  const notice = 'COMPULSORY GALA DINNER CHARGES APPLICABLE FOR CHRISTMAS AND NEW YEAR TO BE PAID AT THE HOTEL DIRECTLY BY THE GUEST';
  assert.equal(getNormalizedMealPlanLabelFromMealSources(`BREAKFAST,${notice}`, 'BreakFast'), 'CP');
  assert.equal(getNormalizedMealPlanLabelFromMealSources(`BREAKFAST AND DINNER;${notice}`, 'Room_Only'), 'MAP');
  assert.equal(getNormalizedMealPlanLabelFromMealSources(notice, 'Room_Only'), 'EP');
  assert.equal(getNormalizedMealPlanLabelFromMealSources('BREAKFAST,COMPLIMENTARY GALA DINNER', 'BreakFast'), 'MAP');
});
