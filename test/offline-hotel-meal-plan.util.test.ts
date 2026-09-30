import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateOfflineMealBreakdown,
  resolveLegacyOfflineMealPlanCode,
} from '../src/modules/itineraries/utils/offline-hotel-meal-plan.util';

describe('offline hotel meal-plan parity', () => {
  it('derives the legacy CP, MAP and AP labels from included meals with prices', () => {
    assert.equal(resolveLegacyOfflineMealPlanCode(
      { breakfast: true, lunch: false, dinner: false },
      { breakfast: 100, lunch: 0, dinner: 0 },
    ), 'CP');
    assert.equal(resolveLegacyOfflineMealPlanCode(
      { breakfast: true, lunch: false, dinner: true },
      { breakfast: 100, lunch: 0, dinner: 300 },
    ), 'MAP');
    assert.equal(resolveLegacyOfflineMealPlanCode(
      { breakfast: true, lunch: true, dinner: true },
      { breakfast: 100, lunch: 200, dinner: 300 },
    ), 'AP');
  });

  it('uses EP when breakfast is absent, even if lunch and dinner exist', () => {
    assert.equal(resolveLegacyOfflineMealPlanCode(
      { breakfast: false, lunch: true, dinner: true },
      { breakfast: 0, lunch: 200, dinner: 300 },
    ), 'EP');
  });

  it('calculates meal totals per person and room using the legacy room rule', () => {
    const result = calculateOfflineMealBreakdown({
      flags: { breakfast: true, lunch: true, dinner: true },
      prices: { breakfast: 100, lunch: 200, dinner: 300 },
      adultCount: 3,
      childCount: 1,
      roomCount: 2,
      roomQuantity: 2,
    });

    assert.equal(result.foodRequiredCount, 2);
    assert.equal(result.totalBreakfastCost, 400);
    assert.equal(result.totalLunchCost, 800);
    assert.equal(result.totalDinnerCost, 1200);
    assert.equal(result.totalMealPlanCost, 2400);
    assert.equal(result.mealPlanCode, 'AP');
  });

  it('uses EP when no pricebook value exists, even if the fallback plan is CP', () => {
    const result = calculateOfflineMealBreakdown({
      flags: { breakfast: true, lunch: false, dinner: false },
      prices: { breakfast: 0, lunch: 0, dinner: 0 },
      fallbackMealPlanCode: 'CP',
      adultCount: 2,
      childCount: 0,
      roomCount: 1,
    });

    assert.equal(result.mealPlanCode, 'EP');
    assert.equal(result.totalMealPlanCost, 0);
  });
});
