import assert from 'node:assert/strict';
import {
  ArrivalWindow,
  HotelSearchMode,
  evaluateArrivalHotelPolicy,
} from '../src/modules/itineraries/services/arrival-hotel-policy.service';
import {
  areCitiesEquivalent,
  normalizeCityName,
} from '../src/modules/itineraries/utils/city-normalization.util';

function makeDate(date: string): Date {
  return new Date(`${date}T00:00:00`);
}

function runPolicyTests() {
  const routeDate = makeDate('2026-05-15');

  const earlyConfirmYes = evaluateArrivalHotelPolicy({
    isArrivalDay: true,
    arrivalMinutes: 6 * 60 + 30,
    routeDate,
    previousDayBillingDecisionProvided: true,
    previousDayBillingConfirmed: true,
  });
  assert.equal(earlyConfirmYes.arrivalWindow, ArrivalWindow.EARLY_01_TO_0759);
  assert.equal(earlyConfirmYes.hotelSearchMode, HotelSearchMode.PREVIOUS_DAY);

  const earlyConfirmNo = evaluateArrivalHotelPolicy({
    isArrivalDay: true,
    arrivalMinutes: 6 * 60 + 30,
    routeDate,
    previousDayBillingDecisionProvided: true,
    previousDayBillingConfirmed: false,
  });
  assert.equal(earlyConfirmNo.arrivalWindow, ArrivalWindow.EARLY_01_TO_0759);
  assert.equal(earlyConfirmNo.hotelSearchMode, HotelSearchMode.SAME_DAY);
  assert.equal(earlyConfirmNo.deferHotelToEndOfDay, true);

  const morning = evaluateArrivalHotelPolicy({
    isArrivalDay: true,
    arrivalMinutes: 10 * 60,
    routeDate,
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false,
  });
  assert.equal(morning.arrivalWindow, ArrivalWindow.MORNING_09_TO_1259);
  assert.equal(morning.deferHotelToEndOfDay, true);

  const onePm = evaluateArrivalHotelPolicy({
    isArrivalDay: true,
    arrivalMinutes: 13 * 60,
    routeDate,
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false,
  });
  assert.equal(onePm.arrivalWindow, ArrivalWindow.AFTERNOON_13_TO_1359);
  assert.equal(onePm.goToHotelImmediately, true);

  const twoPm = evaluateArrivalHotelPolicy({
    isArrivalDay: true,
    arrivalMinutes: 14 * 60,
    routeDate,
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false,
  });
  assert.equal(twoPm.arrivalWindow, ArrivalWindow.AFTERNOON_14_TO_1659);
  assert.equal(twoPm.deferHotelToEndOfDay, true);

  const fivePm = evaluateArrivalHotelPolicy({
    isArrivalDay: true,
    arrivalMinutes: 17 * 60,
    routeDate,
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false,
  });
  assert.equal(fivePm.arrivalWindow, ArrivalWindow.EVENING_17_PLUS);
  assert.equal(fivePm.skipSightseeing, true);

  const exactEight = evaluateArrivalHotelPolicy({
    isArrivalDay: true,
    arrivalMinutes: 8 * 60,
    routeDate,
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false,
  });
  assert.equal(exactEight.arrivalWindow, ArrivalWindow.PRE_SIGHTSEEING_08_TO_0859);

  const exactNine = evaluateArrivalHotelPolicy({
    isArrivalDay: true,
    arrivalMinutes: 9 * 60,
    routeDate,
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false,
  });
  assert.equal(exactNine.arrivalWindow, ArrivalWindow.MORNING_09_TO_1259);

  const normalizedAirport = normalizeCityName('Madurai Airport');
  const normalizedCity = normalizeCityName('Madurai');
  assert.equal(normalizedAirport, normalizedCity);

  const sameCity = areCitiesEquivalent({
    cityNameA: 'Madurai Airport',
    cityNameB: 'Madurai',
  });
  assert.equal(sameCity, true);

  const differentCity = areCitiesEquivalent({
    cityNameA: 'Chennai International Airport',
    cityNameB: 'Madurai',
  });
  assert.equal(differentCity, false);
}

runPolicyTests();
console.log('arrival-hotel-policy tests passed');
