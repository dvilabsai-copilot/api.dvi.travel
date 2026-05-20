import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const ADMIN_EMAIL = process.env.E2E_VENDOR_USER ?? 'admin@dvi.co.in';
const ADMIN_PASSWORD = process.env.E2E_VENDOR_PASSWORD ?? 'Keerthi@2404ias';

const FLOW = {
  stamp: Date.now(),
  guideName: '',
  guideNameEdited: '',
  guideEmail: '',
  guidePassword: '',
  guidePrimaryMobile: '',
  guideId: 0,
  reviewUpdatedText: '',
};

function initFlowData() {
  const stamp = FLOW.stamp;
  FLOW.guideName = `PW Guide ${stamp}`;
  FLOW.guideNameEdited = `PW Guide ${stamp} Edited`;
  FLOW.guideEmail = `pw.guide.${stamp}@example.com`;
  FLOW.guidePassword = 'Guide@12345';
  FLOW.guidePrimaryMobile = `9${String(stamp).slice(-9)}`;
  FLOW.reviewUpdatedText = `Updated review ${stamp}`;
}

async function maybeLogin(page: Page): Promise<void> {
  const signInHeading = page.getByRole('heading', { name: /sign\s*in/i }).first();
  if ((await signInHeading.count()) === 0) return;

  const labeledEmailInput = page
    .locator('input[type="email"], input[name="email"], input[placeholder*="Email" i]')
    .first();
  const labeledPasswordInput = page
    .locator('input[type="password"], input[name="password"], input[placeholder*="Password" i]')
    .first();

  let emailInput = labeledEmailInput;
  let passwordInput = labeledPasswordInput;

  if ((await labeledEmailInput.count()) === 0 || (await labeledPasswordInput.count()) === 0) {
    const textboxes = page.getByRole('textbox');
    const textboxCount = await textboxes.count();
    if (textboxCount < 2) return;
    emailInput = textboxes.nth(0);
    passwordInput = textboxes.nth(1);
  }

  await emailInput.fill(ADMIN_EMAIL);
  await passwordInput.fill(ADMIN_PASSWORD);

  const loginButton = page.getByRole('button', { name: /log\s*in|login|sign\s*in/i }).first();
  if ((await loginButton.count()) > 0) {
    await loginButton.click();
  } else {
    await passwordInput.press('Enter');
  }
  await page.waitForLoadState('networkidle');
}

async function gotoGuideList(page: Page, baseURL: string | undefined): Promise<void> {
  await page.goto(`${baseURL}/guide`, { waitUntil: 'domcontentloaded' });
  await maybeLogin(page);
  if (!page.url().includes('/guide')) {
    await page.goto(`${baseURL}/guide`, { waitUntil: 'domcontentloaded' });
  }
  await expect(page.getByRole('heading', { name: /List of Guide/i })).toBeVisible();
}

async function selectFirstOptionForLabel(page: Page, label: RegExp): Promise<string> {
  const field = page
    .locator('div')
    .filter({ has: page.getByText(label) })
    .filter({ has: page.getByRole('combobox') })
    .first();

  const combo = field.getByRole('combobox').first();
  await expect(combo).toBeVisible();
  await combo.click();

  const option = page.getByRole('option').first();
  await expect(option).toBeVisible();
  const selectedText = (await option.textContent())?.trim() ?? '';
  await option.click();
  return selectedText;
}

async function selectFirstOptionForComboboxIndex(
  page: Page,
  comboIndex: number,
  allowEmpty = false,
): Promise<string> {
  const combo = page.getByRole('combobox').nth(comboIndex);
  await expect(combo).toBeVisible();

  for (let i = 0; i < 20; i++) {
    await combo.click();
    const options = page.getByRole('option');
    const optionCount = await options.count();
    if (optionCount > 0) {
      const option = options.first();
      await expect(option).toBeVisible();
      const selectedText = (await option.textContent())?.trim() ?? '';
      await option.click();
      return selectedText;
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }

  if (allowEmpty) return '';
  throw new Error(`No options available for combobox index ${comboIndex}`);
}

async function selectNonZeroGstPercentage(page: Page, comboIndex: number): Promise<string> {
  const combo = page.getByRole('combobox').nth(comboIndex);
  await expect(combo).toBeVisible();
  await combo.click();

  const options = page.getByRole('option');
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    const text = ((await option.textContent()) ?? '').trim();
    const numeric = Number((text.match(/\d+(?:\.\d+)?/) ?? [''])[0]);
    if (Number.isFinite(numeric) && numeric > 0) {
      await option.click();
      return text;
    }
  }

  // Fallback if only zero/empty values exist.
  if (count > 0) {
    const first = options.first();
    const text = ((await first.textContent()) ?? '').trim();
    await first.click();
    return text;
  }

  throw new Error('No GST percentage options available');
}

async function fillInputForLabel(page: Page, label: RegExp, value: string) {
  const anchor = page.getByText(label).first();
  const input = anchor.locator('xpath=following::input[1]');
  await expect(input).toBeVisible();
  await input.fill(value);
}

async function fillTextareaForLabel(page: Page, label: RegExp, value: string) {
  const anchor = page.getByText(label).first();
  const textarea = anchor.locator('xpath=following::textarea[1]');
  await expect(textarea).toBeVisible();
  await textarea.fill(value);
}

function inputForLabel(page: Page, label: RegExp) {
  const anchor = page.getByText(label).first();
  return anchor.locator('xpath=following::input[1]');
}

async function expectToast(page: Page, text: string) {
  await expect(page.getByText(text).first()).toBeVisible();
}

async function openGuideRowByName(page: Page, name: string) {
  const searchInput = page
    .getByText(/^Search:$/i)
    .locator('xpath=..')
    .getByRole('textbox')
    .first();

  for (let attempt = 0; attempt < 3; attempt++) {
    await searchInput.fill(name);
    const row = page.locator('tr', { hasText: name }).first();
    if (await row.isVisible().catch(() => false)) {
      return row;
    }
    await page.waitForTimeout(1500);
    if (await row.isVisible().catch(() => false)) {
      return row;
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await maybeLogin(page);
    await expect(page.getByRole('heading', { name: /List of Guide/i })).toBeVisible();
  }

  const row = page.locator('tr', { hasText: name }).first();
  await expect(row).toBeVisible();
  return row;
}

async function extractGuideIdFromUrl(page: Page): Promise<number> {
  const m = page.url().match(/\/guide\/(\d+)\/edit/i);
  return Number(m?.[1] ?? 0);
}

async function saveBasicAndWait(page: Page): Promise<void> {
  const saveResponse = page
    .waitForResponse(
      (resp) => {
        const method = resp.request().method();
        const url = resp.url();
        if (!['POST', 'PUT'].includes(method)) return false;
        return (
          /\/api\/v1\/guides(\/\d+)?$/i.test(url) ||
          /\/api\/v1\/guides\/ajax\/manage\?type=guide_basic_info/i.test(url)
        );
      },
      { timeout: 20000 },
    )
    .catch(() => null);

  await page.getByRole('button', { name: /Save\s*&\s*Continue|Update\s*&\s*Continue/i }).click();

  const resp = await saveResponse;
  if (resp) {
    expect(resp.ok(), `Guide basic save failed: ${resp.status()} ${await resp.text()}`).toBeTruthy();
  }
  await expect(page.getByRole('button', { name: /^2\s*Pricebook$/i })).toBeVisible();
}

async function updatePricebookAndWait(page: Page, expectContinue = true): Promise<void> {
  const pricebookResponse = page.waitForResponse(
    (resp) => /\/api\/v1\/guides\/\d+\/pricebook$/i.test(resp.url()) && ['PATCH', 'PUT'].includes(resp.request().method()),
    { timeout: 60000 },
  );

  await page.getByRole('button', { name: /Update(\s*&\s*Continue)?/i }).first().click();
  const resp = await pricebookResponse;
  expect(resp.ok(), `Pricebook save failed: ${resp.status()} ${await resp.text()}`).toBeTruthy();

  if (expectContinue) {
    await expect(page.getByText(/List of Reviews/i)).toBeVisible();
  }
}

async function getAuthApiBase(baseURL: string | undefined): Promise<string> {
  if (process.env.E2E_API_BASE_URL && process.env.E2E_API_BASE_URL.trim()) {
    return process.env.E2E_API_BASE_URL.trim().replace(/\/+$/, '');
  }
  return 'http://127.0.0.1:4006/api/v1';
}

async function loginForToken(request: APIRequestContext, apiBase: string): Promise<string> {
  const res = await request.post(`${apiBase}/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.ok(), `Admin login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const json = (await res.json()) as { accessToken?: string };
  const token = String(json?.accessToken ?? '').trim();
  expect(token).toBeTruthy();
  return token;
}

async function assertGuideUserLogin(request: APIRequestContext, apiBase: string, email: string, password: string) {
  const res = await request.post(`${apiBase}/auth/login`, {
    data: { email, password },
  });
  expect(res.ok(), `Guide user login failed unexpectedly: ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function assertGuideUserLoginBlocked(
  request: APIRequestContext,
  apiBase: string,
  email: string,
  password: string,
) {
  const res = await request.post(`${apiBase}/auth/login`, {
    data: { email, password },
  });
  expect(res.status()).toBe(401);
}

test.describe('Guide module E2E', () => {
  test.describe.configure({ mode: 'serial' });

  test('full create/edit/preview/delete flow with auth guard verification', async ({ page, baseURL, request }) => {
    test.setTimeout(360000);
    initFlowData();

    const apiBase = await getAuthApiBase(baseURL);
    const adminToken = await loginForToken(request, apiBase);
    await page.addInitScript((token: string) => {
      window.localStorage.setItem('accessToken', token);
    }, adminToken);

    // 1. Guide list page loads
    await gotoGuideList(page, baseURL);

    // 2. Search works (empty query + no crash)
    const searchInput = page
      .getByText(/^Search:$/i)
      .locator('xpath=..')
      .getByRole('textbox')
      .first();
    await searchInput.fill('non-existent-guide-term');
    await expect(page.getByText(/No guides found/i)).toBeVisible();
    await searchInput.fill('');

    // 3 & 4. Add flow + required validation checks
    await page.getByRole('button', { name: /Add Guide/i }).click();
    await expect(page.getByRole('heading', { name: /Add Guide/i })).toBeVisible();

    await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
    await expectToast(page, 'Guide Name Required');

    await fillInputForLabel(page, /^Guide Name\s*\*/i, FLOW.guideName);
    await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
    await expectToast(page, 'Guide Gender Required');

    await selectFirstOptionForComboboxIndex(page, 1);
    await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
    await expectToast(page, 'Guide Primart Mobile no Required');

    await fillInputForLabel(page, /^Primary Mobile Number\s*\*/i, FLOW.guidePrimaryMobile);
    await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
    await expectToast(page, 'Email ID Required');

    await fillInputForLabel(page, /^Email ID\s*\*/i, FLOW.guideEmail);
    await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
    await expectToast(page, 'Role Required');

    await fillInputForLabel(page, /^Password\s*\*/i, FLOW.guidePassword);
    await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
    await expectToast(page, 'Role Required');

    await selectFirstOptionForComboboxIndex(page, 2);
    await page.getByRole('button', { name: /Save\s*&\s*Continue/i }).click();
    await expectToast(page, 'Language Proficiency Required');

    const statesResponse = page
      .waitForResponse((resp) => /\/api\/v1\/guides\/dropdowns\/states\?countryId=/i.test(resp.url()), {
        timeout: 15000,
      })
      .catch(() => null);

    const selectedCountry = await selectFirstOptionForComboboxIndex(page, 4);
    await expect(page.locator('[role="combobox"]').filter({ hasText: selectedCountry }).first()).toBeVisible();
    await statesResponse;

    const citiesResponse = page
      .waitForResponse((resp) => /\/api\/v1\/guides\/dropdowns\/cities\?stateId=/i.test(resp.url()), {
        timeout: 15000,
      })
      .catch(() => null);
    await selectFirstOptionForComboboxIndex(page, 5);
    await citiesResponse;
    await selectFirstOptionForComboboxIndex(page, 6, true);

    await selectFirstOptionForComboboxIndex(page, 3);
    await selectFirstOptionForComboboxIndex(page, 7);
    await selectNonZeroGstPercentage(page, 8);

    // 10. Available slot selection works
    await page.getByLabel(/Slot 1: 9 AM to 1 PM/i).check();
    await page.getByLabel(/Slot 2: 9 AM to 4 PM/i).check();

    // 8. Preferred For behavior: hotspot
    await page.getByLabel(/^Hotspot$/i).check();
    await selectFirstOptionForLabel(page, /Hotspot Place\s*\*/i);

    // 8. Preferred For behavior: activity (switch clears hotspot chips)
    await page.getByLabel(/^Activity$/i).check();
    await expect(page.getByText(/Hotspot Place \*/i)).toHaveCount(0);
    await selectFirstOptionForLabel(page, /^Activity\s*\*/i);

    // 8. Preferred For behavior: itinerary (exclusive)
    await page.getByLabel(/^Itinerary$/i).check();
    await expect(page.getByText(/Activity \*/i)).toHaveCount(0);

    await saveBasicAndWait(page);

    await expect(page).toHaveURL(/\/guide\/\d+\/edit/);
    FLOW.guideId = await extractGuideIdFromUrl(page);
    expect(FLOW.guideId > 0).toBeTruthy();

    // 18 pre-delete check: created guide user can authenticate
    await assertGuideUserLogin(request, apiBase, FLOW.guideEmail, FLOW.guidePassword);

    // 11. Pricebook save works
    await page.getByPlaceholder('Start Date').fill('2026-06-01');
    await page.getByPlaceholder('End date').fill('2026-06-03');
    await page.locator('input[placeholder="Enter Price"]').first().fill('111');
    await updatePricebookAndWait(page);

    // 12. Overlapping pricebook save behaves like PHP (second overlapping save allowed)
    await page.getByRole('button', { name: /^2\s*Pricebook$/i }).click();
    await page.getByPlaceholder('Start Date').fill('2026-06-02');
    await page.getByPlaceholder('End date').fill('2026-06-04');
    await page.locator('input[placeholder="Enter Price"]').first().fill('222');
    await updatePricebookAndWait(page);

    // 13. Review add works
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: /4 Stars/i }).click();
    const initialReview = `Guide review ${FLOW.stamp}`;
    await fillTextareaForLabel(page, /^Feedback\s*\*/i, initialReview);

    const addReviewResponse = page.waitForResponse(
      (resp) => /\/api\/v1\/guides\/\d+\/reviews$/i.test(resp.url()) && resp.request().method() === 'POST',
      { timeout: 60000 },
    );
    await page.getByRole('button', { name: /^Save$/i }).click();
    const addResp = await addReviewResponse;
    expect(addResp.ok(), `Review add failed: ${addResp.status()} ${await addResp.text()}`).toBeTruthy();
    await expect(page.getByText(initialReview)).toBeVisible();

    // 14. Review edit works
    const reviewRow = page.locator('tr', { hasText: initialReview }).first();
    await reviewRow.locator('button').first().click();
    await fillTextareaForLabel(page, /^Feedback\s*\*/i, FLOW.reviewUpdatedText);

    const editReviewResponse = page.waitForResponse(
      (resp) => /\/api\/v1\/guides\/\d+\/reviews\/\d+$/i.test(resp.url()) && resp.request().method() === 'PUT',
      { timeout: 60000 },
    );
    await page.getByRole('button', { name: /^Update$/i }).click();
    const editResp = await editReviewResponse;
    expect(editResp.ok(), `Review edit failed: ${editResp.status()} ${await editResp.text()}`).toBeTruthy();
    await expect(page.getByText(FLOW.reviewUpdatedText)).toBeVisible();

    // 15. Review delete works
    const updatedRow = page.locator('tr', { hasText: FLOW.reviewUpdatedText }).first();
    const reviewDeleteResponse = page.waitForResponse(
      (resp) => /\/api\/v1\/guides\/(\d+)\/reviews\/(\d+)$/i.test(resp.url()) && resp.request().method() === 'DELETE',
      { timeout: 60000 },
    );
    await updatedRow.locator('button').nth(1).click();
    const deleteResp = await reviewDeleteResponse;
    expect(deleteResp.ok(), `Review delete failed: ${deleteResp.status()} ${await deleteResp.text()}`).toBeTruthy();
    await expect(page.getByText(FLOW.reviewUpdatedText)).toHaveCount(0);

    // Move to preview and confirm labels render
    await page.getByRole('button', { name: /Skip and Continue/i }).click();
    await expect(page.getByText(/Basic Info/i).first()).toBeVisible();
    await page.getByRole('button', { name: /Confirm/i }).click();

    // 5. Edit guide works + 6. email readonly in edit mode + 9. preferred persistence
    await gotoGuideList(page, baseURL);
    let row = await openGuideRowByName(page, FLOW.guideName);
    await row.locator('button').nth(1).click();

    await expect(page).toHaveURL(new RegExp(`/guide/${FLOW.guideId}/edit`));
    await expect(inputForLabel(page, /^Email ID\s*\*/i)).toHaveAttribute('readonly', '');

    await fillInputForLabel(page, /^Guide Name\s*\*/i, FLOW.guideNameEdited);
    await expect(page.getByLabel(/^Itinerary$/i)).toBeChecked();
    await saveBasicAndWait(page);

    // 16. Preview page loads correct labels
    await gotoGuideList(page, baseURL);
    row = await openGuideRowByName(page, FLOW.guideNameEdited);
    await row.locator('button').first().click();
    await expect(page).toHaveURL(new RegExp(`/guide/${FLOW.guideId}/preview`));
    await expect(page.getByText('Basic Info')).toBeVisible();
    await expect(page.getByText('Bank Details')).toBeVisible();
    await expect(page.getByText('Guide Prefered For')).toBeVisible();
    await expect(page.getByText('Feedback & Review')).toBeVisible();
    await expect(page.getByText(FLOW.guideNameEdited).first()).toBeVisible();

    // 17. Delete guide works from UI row action
    await page.getByRole('button', { name: /Back/i }).click();
    await gotoGuideList(page, baseURL);
    row = await openGuideRowByName(page, FLOW.guideNameEdited);
    page.once('dialog', (dialog) => dialog.accept());

    const deleteGuideResponse = page.waitForResponse(
      (resp) => /\/api\/v1\/guides\/\d+$/i.test(resp.url()) && resp.request().method() === 'DELETE',
      { timeout: 60000 },
    );
    await row.locator('button[title="Delete"]').click();
    const deleteGuideResp = await deleteGuideResponse;
    expect(deleteGuideResp.ok(), `Guide delete failed: ${deleteGuideResp.status()} ${await deleteGuideResp.text()}`).toBeTruthy();

    const searchInputAfterDelete = page
      .getByText(/^Search:$/i)
      .locator('xpath=..')
      .getByRole('textbox')
      .first();
    await searchInputAfterDelete.fill(FLOW.guideNameEdited);
    await expect(page.getByText(/No guides found/i)).toBeVisible();

    // 18. Deleted guide user cannot authenticate
    await assertGuideUserLoginBlocked(request, apiBase, FLOW.guideEmail, FLOW.guidePassword);
  });
});
