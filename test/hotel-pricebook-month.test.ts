import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeHotelPricebookMonth } from '../src/modules/hotels/hotel-pricebook-month.util';

describe('hotel meal pricebook month normalization', () => {
  it('normalizes legacy month names and numeric values to the same key', () => {
    assert.equal(normalizeHotelPricebookMonth('October'), '10');
    assert.equal(normalizeHotelPricebookMonth('oct'), '10');
    assert.equal(normalizeHotelPricebookMonth('10'), '10');
    assert.equal(normalizeHotelPricebookMonth('09'), '09');
  });

  it('rejects invalid month values instead of creating an unmatched row key', () => {
    assert.equal(normalizeHotelPricebookMonth('Octoberr'), '');
    assert.equal(normalizeHotelPricebookMonth(''), '');
    assert.equal(normalizeHotelPricebookMonth(13), '');
  });
});
