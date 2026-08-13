import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCanonicalPlanMealSelection } from '../src/modules/itineraries/engines/plan-engine.service';

const cases = [
  { code: 'CP', breakfast: 1, lunch: 0, dinner: 0 },
  { code: 'EP', breakfast: 0, lunch: 0, dinner: 0 },
  { code: 'MAP', breakfast: 1, lunch: 0, dinner: 1 },
  { code: 'AP', breakfast: 1, lunch: 1, dinner: 1 },
];

for (const expected of cases) {
  test(`canonical ${expected.code} overrides contradictory legacy flags`, () => {
    assert.deepEqual(
      resolveCanonicalPlanMealSelection({
        meal_plan_code: expected.code,
        meal_plan_breakfast: expected.breakfast ? 0 : 1,
        meal_plan_lunch: expected.lunch ? 0 : 1,
        meal_plan_dinner: expected.dinner ? 0 : 1,
      }),
      {
        mealPlanCode: expected.code,
        breakfast: expected.breakfast,
        lunch: expected.lunch,
        dinner: expected.dinner,
      },
    );
  });
}

test('legacy flags remain a fallback when no canonical code is supplied', () => {
  assert.deepEqual(
    resolveCanonicalPlanMealSelection({
      meal_plan_breakfast: 1,
      meal_plan_lunch: 1,
      meal_plan_dinner: 0,
    }),
    { mealPlanCode: 'MAP', breakfast: 1, lunch: 1, dinner: 0 },
  );
});

test('absent meal-plan code and flags remain unspecified instead of becoming EP', () => {
  assert.deepEqual(
    resolveCanonicalPlanMealSelection({}),
    { mealPlanCode: null, breakfast: 0, lunch: 0, dinner: 0 },
  );
});
