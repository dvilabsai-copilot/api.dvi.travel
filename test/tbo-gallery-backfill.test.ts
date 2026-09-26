import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTboHotelCodes,
  extractTboImageUrls,
  isAcceptableTboGalleryDimensions,
} from '../src/modules/hotels/services/tbo-master-gallery.service';

test('TBO gallery backfill selects only TBO/VSR rows and deduplicates hotel codes', () => {
  assert.deepEqual(extractTboHotelCodes([
    { provider: 'tbo', providerHotelCode: '1089829' },
    { provider: 'VSR', provider_hotel_code: '1089829' },
    { provider: 'axisrooms', providerHotelCode: 'AX-1' },
    { hotel_provider: 'vsr', hotel_code: '1075899' },
    { provider: 'offline', hotelCode: 'OFF-1' },
  ]), ['1089829', '1075899']);
});

test('TBO gallery backfill preserves unique supplier image URL order', () => {
  assert.deepEqual(extractTboImageUrls({
    Image: 'https://cdn.example/primary.jpg',
    Images: ['https://cdn.example/primary.jpg', 'https://cdn.example/second.jpg', ''],
  }), [
    'https://cdn.example/primary.jpg',
    'https://cdn.example/second.jpg',
  ]);
});

test('TBO gallery backfill rejects portrait-only candidates such as bathroom photos', () => {
  assert.equal(isAcceptableTboGalleryDimensions({ width: 500, height: 375 }), true);
  assert.equal(isAcceptableTboGalleryDimensions({ width: 375, height: 500 }), false);
  assert.equal(isAcceptableTboGalleryDimensions(null), false);
});
