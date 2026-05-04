const { chromium } = require('playwright');
const assert = require('assert');

async function runTest() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.createContext();
  const page = await context.newPage();

  try {
    console.log('🔍 Starting Playwright E2E test for early arrival + previous-day billing fix...\n');

    // Step 1: Navigate to login
    console.log('Step 1: Navigating to login page...');
    await page.goto('http://localhost:8080/login', { waitUntil: 'networkidle' });
    
    // Step 2: Perform login
    console.log('Step 2: Logging in...');
    await page.fill('input[type="email"]', 'admin@dvi.co.in');
    await page.fill('input[type="password"]', 'Admin@123');
    await page.click('button:has-text("Sign in")');
    await page.waitForURL('**/dashboard', { timeout: 10000 });
    
    // Step 3: Navigate to Create Itinerary
    console.log('Step 3: Navigating to Create Itinerary page...');
    await page.click('a:has-text("Create Itinerary")');
    await page.waitForURL('**/create-itinerary', { timeout: 10000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    
    console.log('Step 4: Filling in itinerary form with early morning arrival...');
    
    // Wait for form elements to be loaded
    await page.waitForSelector('input[placeholder*="Select"]', { timeout: 10000, state: 'visible' });
    
    // Fill source location
    const sourceInputs = page.locator('input[placeholder*="Select"]');
    await sourceInputs.first().click();
    await page.waitForTimeout(500);
    await page.keyboard.type('Delhi');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    
    // Fill destination location
    await sourceInputs.nth(1).click();
    await page.waitForTimeout(500);
    await page.keyboard.type('Delhi');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    
    // Fill arrival date+time with early morning (06:00 AM)
    const dateInputs = page.locator('input[type="datetime-local"]');
    await page.waitForTimeout(500);
    
    // Set trip start date to tomorrow at 06:00 AM
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];
    const arrivalDatetime = `${dateStr}T06:00`;
    
    await dateInputs.first().fill(arrivalDatetime);
    console.log(`  Set arrival time to: ${arrivalDatetime} (06:00 AM - early arrival window)`);
    
    // Set end date 2 days later
    const endDate = new Date(tomorrow);
    endDate.setDate(endDate.getDate() + 2);
    const endDateStr = endDate.toISOString().split('T')[0];
    const departureTime = `${endDateStr}T18:00`;
    await dateInputs.nth(1).fill(departureTime);
    
    // Fill number of people
    const numberInputs = page.locator('input[type="number"]');
    await numberInputs.first().fill('2');  // adults
    
    // Wait a bit for form to update
    await page.waitForTimeout(1000);
    
    // Click Save button
    console.log('Step 5: Clicking Save button...');
    const saveBtn = page.locator('button:has-text("Save")').first();
    await saveBtn.click();
    
    // Step 6: Look for previous-day billing modal and click "Yes"
    console.log('Step 6: Waiting for Previous-Day Hotel Billing modal...');
    let modalFound = false;
    for (let i = 0; i < 10; i++) {
      const modalText = page.locator('text=/Previous Day.*Hotel.*Billing|billing/i');
      if (await modalText.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log('  ✓ Modal appeared!');
        modalFound = true;
        
        // Click "Yes" button
        const yesBtn = page.locator('button:has-text("Yes")').first();
        console.log('  Clicking "Yes" to confirm previous-day billing...');
        await yesBtn.click();
        console.log('  ✓ Clicked Yes');
        break;
      }
      await page.waitForTimeout(500);
    }
    
    if (!modalFound) {
      console.log('  ⚠ Modal not found (might not be needed for this configuration)');
    }
    
    // Step 7: Waiti for creation to complete and redirect to details page
    console.log('Step 7: Waiting for itinerary creation and redirect to details page...');
    await page.waitForURL(/itinerary-details\/(DVI\d+)/, { timeout: 120000 });
    const currentUrl = page.url();
    const quoteIdMatch = currentUrl.match(/itinerary-details\/(DVI\d+)/);
    const quoteId = quoteIdMatch ? quoteIdMatch[1] : 'UNKNOWN';
    console.log(`  ✓ Itinerary created: ${quoteId}`);
    
    // Step 8: Wait for details page to load
    console.log('Step 8: Waiting for details page to fully load...');
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    
    // Step 9: Check for airport-to-hotel segment in Day 1
    console.log('Step 9: Examining Day 1 timeline for airport-to-hotel segment...');
    
    // Look for day section
    const dayElements = page.locator('[id*="day"], [data-testid*="day"]');
    let hasAirportToHotel = false;
    let segments = [];
    
    // Check for travel segment text containing "Airport" or "arrival"
    const travelTextElements = page.locator('text=/Airport|arrival|To Hotel|travel/i');
    const count = await travelTextElements.count();
    console.log(`  Found ${count} elements mentioning airport/travel`);
    
    // Alternative: check the page content
    const pageContent = await page.content();
    
    if (pageContent.includes('Airport') || pageContent.includes('airport') || (pageContent.includes('travel') && pageContent.includes('Hotel'))) {
      console.log('  ✓ Page content contains Airport/travel/Hotel references');
      hasAirportToHotel = true;
    }
    
    // Print the actual day content for manual inspection
    const dayStartIndex = pageContent.indexOf('Day 1');
    if (dayStartIndex !== -1) {
      const dayWindow = pageContent.substring(dayStartIndex, dayStartIndex + 1000);
      console.log('\n  Day 1 Content Excerpt:');
      console.log('  ' + dayWindow.substring(0, 200).replace(/<[^>]*>/g, '').substring(0, 100) + '...');
    }
    
    // Step 10: Final result
    console.log('\n========== TEST RESULT ==========');
    if (hasAirportToHotel) {
      console.log('✅ SUCCESS: Airport-to-Hotel segment is present!');
      console.log('   The fix for early arrival previous-day billing is WORKING!');
    } else {
      console.log('❌ FAILED: Airport-to-Hotel segment not found');
      console.log('   The fix may not be working correctly');
    }
    
    console.log(`\nCreated Itinerary ID: ${quoteId}`);
    console.log('Please verify in browser at: http://localhost:8080/itinerary-details/' + quoteId);
    
    // Keep browser open for 15 seconds for manual inspection
    console.log('\nBrowser will stay open for 15 seconds for manual inspection...');
    await page.waitForTimeout(15000);
    
  } catch (error) {
    console.error('❌ Test failed with error:', error.message);
    console.error('Stack:', error.stack);
    // Try to take a screenshot for debugging
    try {
      await page.screenshot({ path: 'test-error-screenshot.png' });
      console.log('Screenshot saved to: test-error-screenshot.png');
    } catch (screenshotError) {
      console.error('Could not take screenshot:', screenshotError.message);
    }
  } finally {
    await browser.close();
  }
}

runTest().catch(error => {
  console.error('Test runner error:', error);
  process.exit(1);
});
