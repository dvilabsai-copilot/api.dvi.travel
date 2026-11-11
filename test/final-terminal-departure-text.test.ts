import assert from 'node:assert/strict';
import test from 'node:test';
import { getFinalTerminalDepartureText } from '../src/modules/itineraries/utils/final-terminal-departure-text.util';

const configuredText = 'Configured departure copy';

test('uses configured end text for the final airport transfer', () => {
  assert.equal(
    getFinalTerminalDepartureText({
      routeIndex: 2,
      routeCount: 3,
      destination: 'Rajiv Gandhi International Airport',
      configuredText,
    }),
    configuredText,
  );
});

test('does not attach the configured end text to a non-final terminal transfer', () => {
  assert.equal(
    getFinalTerminalDepartureText({
      routeIndex: 1,
      routeCount: 3,
      destination: 'Central Railway Station',
      configuredText,
    }),
    undefined,
  );
});

test('does not attach the configured end text to a final hotel return', () => {
  assert.equal(
    getFinalTerminalDepartureText({
      routeIndex: 2,
      routeCount: 3,
      destination: 'Hotel',
      configuredText,
    }),
    undefined,
  );
});

test('omits the optional text when the global setting is blank', () => {
  assert.equal(
    getFinalTerminalDepartureText({
      routeIndex: 0,
      routeCount: 1,
      destination: 'Airport',
      configuredText: '  ',
    }),
    undefined,
  );
});
