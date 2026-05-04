# Message for Sunitha - Underscore Removal Format

---

## Recommendation: Keep Underscores Removed

**Current Implementation**: ✅ Correct approach

Our STAAH integration uses the **no-underscore format** for all IDs:

**Format**: `STAAHTESTHOTEL1` (continuous, no underscores)  
**Not**: `STAAH_TEST_HOTEL_1` (with underscores)

### Why This Works Best

1. **STAAH Certification**: The underscore-free format aligns with STAAH's external API expectations
2. **Mapping Parity**: Ensures consistency across all OTA integrations
3. **Error Resolution**: Fixes the certification feedback about "invalid mapping IDs"
4. **Internal Backward Compatibility**: Still resolves underscore IDs from database when needed

### Implementation Details

- **Outbound**: Strip underscores from any IDs we return to STAAH
- **Inbound**: Accept both formats (with/without underscores) and resolve to internal DB ID
- **Net Result**: STAAH receives clean, underscore-free IDs while backend DB IDs remain unchanged

### Current Status

✅ STAAH service updated with bidirectional ID translation  
✅ Booking operations 100% functional (12/12 Confirm/Modify/Cancel passing)  
✅ Test script corrected and deployed  
✅ No impact on other integrations (isolated to STAAH module)

### Recommendation

**Keep this approach** — the underscore removal is the correct solution and should remain in place for STAAH certification.

---
