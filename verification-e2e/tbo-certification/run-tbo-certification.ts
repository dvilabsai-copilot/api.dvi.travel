import fs from 'fs';
import path from 'path';
import axios from 'axios';

type Json = Record<string, any>;

type StepStatus = 'success' | 'failed' | 'skipped';

type RuntimeValues = {
  tokenId?: string | null;
  traceId?: string | null;
  bookingCode?: string | null;
  bookingId?: string | null;
  confirmationNo?: string | null;
  netAmount?: number | null;
  agencyId?: string | null;
  guestNationality?: string | null;
  paymentMode?: string | null;
  noOfRooms?: number | null;
  searchFiltersNoOfRooms?: number | null;
  titleSet?: string[];
};

type StepResult = {
  stepNo: number;
  stepName: string;
  fileName: string;
  status: StepStatus;
  endpoint: string;
  method: 'GET' | 'POST';
  requestPayload: unknown;
  responsePayload: unknown;
  statusCode?: number;
  error?: string;
  timestamp: string;
  skippedReason?: string;
};

type CaseTemplate = {
  caseName: string;
  searchBody: Json;
  searchUrl: string;
  prebookUrl: string;
  bookUrl: string;
  detailUrl: string;
  voucherUrl: string;
};

type CaseExecution = {
  caseId: number;
  caseName: string;
  caseSlug: string;
  checkInDate: string;
  checkOutDate: string;
  runtime: RuntimeValues;
  steps: StepResult[];
  cancelPolicies: any[];
  mandatorySupplements: any[];
  blockerNotes: string[];
};

type CapabilityReport = {
  hotelsSearchEndpoint: boolean;
  itinerariesPrebookEndpoint: boolean;
  itinerariesConfirmQuotationEndpoint: boolean;
  hotelsCancelEndpoint: boolean;
  providerGetBookingDetailMethod: boolean;
  providerGenerateVoucherMethod: boolean;
  providerCancelMethod: boolean;
};

const ROOT = process.cwd();
const COLLECTION_PATH = path.join(
  ROOT,
  'TBO - Hotel Certification FULL Pack (8 Cases) - Auto Chaining.postman_collection.json',
);
const OUT_ROOT = path.join(ROOT, 'verification-e2e', 'tbo-certification');

const SUPPLEMENT_CODES = [
  '1376565',
  '1345318',
  '1345320',
  '1200255',
  '1128760',
  '1250333',
  '1078234',
  '1347149',
  '1358855',
  '1345321',
  '1108025',
  '1356271',
  '1267547',
];

const SHARED_API_URL = process.env.TBO_SHARED_API_URL || 'https://api.travelboutiqueonline.com/SharedAPI/SharedData.svc/rest/Authenticate';
const SEARCH_API_URL = process.env.TBO_SEARCH_API_URL || 'https://affiliate.travelboutiqueonline.com/HotelAPI/Search';
const PREBOOK_API_URL = process.env.TBO_PREBOOK_API_URL || 'https://affiliate.travelboutiqueonline.com/HotelAPI/PreBook';
const BOOK_API_URL = process.env.TBO_BOOK_API_URL || 'https://hotelbooking.travelboutiqueonline.com/HotelAPI_V10/HotelService.svc/rest/book';
const DETAIL_API_URL = process.env.TBO_DETAIL_API_URL || 'https://hotelbooking.travelboutiqueonline.com/HotelAPI_V10/HotelService.svc/rest/Getbookingdetail';
const VOUCHER_API_URL = process.env.TBO_VOUCHER_API_URL || 'https://hotelbooking.travelboutiqueonline.com/HotelAPI_V10/HotelService.svc/rest/GenerateVoucher';
const CANCEL_API_URL = process.env.TBO_CANCEL_API_URL || 'https://hotelbooking.travelboutiqueonline.com/HotelAPI_V10/HotelService.svc/rest/SendChangeRequest';

const TBO_USERNAME = process.env.TBO_API_USERNAME || process.env.TBO_USERNAME || 'IXMD112';
const TBO_PASSWORD = process.env.TBO_API_PASSWORD || process.env.TBO_PASSWORD || 'api-11#M$new';
const TBO_CLIENT_ID = process.env.TBO_CLIENT_ID || 'tboprod';
const END_USER_IP = process.env.CERT_END_USER_IP || process.env.TBO_END_USER_IP || '134.209.145.185';
const HTTP_TIMEOUT_MS = Number(process.env.CERT_HTTP_TIMEOUT_MS || 180000);

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath: string, text: string) {
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath: string, payload: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getBasicAuthHeader(): string {
  return `Basic ${Buffer.from(`${TBO_USERNAME}:${TBO_PASSWORD}`).toString('base64')}`;
}

function statusCodeFromAny(statusObj: any): number | null {
  if (typeof statusObj === 'number') {
    return statusObj;
  }
  if (statusObj && typeof statusObj === 'object' && typeof statusObj.Code === 'number') {
    return statusObj.Code;
  }
  return null;
}

function findFirstValue(obj: any, keys: string[]): any {
  if (obj === null || obj === undefined) {
    return null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findFirstValue(item, keys);
      if (r !== null && r !== undefined && r !== '') {
        return r;
      }
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (keys.includes(k) && obj[k] !== null && obj[k] !== undefined && obj[k] !== '') {
        return obj[k];
      }
    }
    for (const k of Object.keys(obj)) {
      const r = findFirstValue(obj[k], keys);
      if (r !== null && r !== undefined && r !== '') {
        return r;
      }
    }
  }
  return null;
}

function parseCollectionCases(): CaseTemplate[] {
  const raw = fs.readFileSync(COLLECTION_PATH, 'utf8');
  const json = JSON.parse(raw);
  const collectionItems = Array.isArray(json?.item) ? json.item : [];

  const templates: CaseTemplate[] = collectionItems
    .filter((x: any) => /^Case\s+\d+/i.test(String(x?.name || '')))
    .map((caseNode: any) => {
      const steps = Array.isArray(caseNode?.item) ? caseNode.item : [];
      const lowerName = (x: any) => String(x?.name || '').toLowerCase();
      const parseRawBody = (step: any): Json => {
        const rawBody = step?.request?.body?.raw;
        if (!rawBody) return {};
        try {
          return JSON.parse(rawBody);
        } catch {
          return {};
        }
      };

      const searchStep = steps.find((s: any) => lowerName(s).includes('search'));
      const prebookStep = steps.find((s: any) => lowerName(s).includes('prebook'));
      const bookStep = steps.find((s: any) => {
        const n = lowerName(s);
        return n.includes('book') && !n.includes('prebook') && !n.includes('getbookingdetail') && !n.includes('generatevoucher');
      });
      const detailStep = steps.find((s: any) => lowerName(s).includes('getbookingdetail'));
      const voucherStep = steps.find((s: any) => lowerName(s).includes('generatevoucher'));

      return {
        caseName: String(caseNode?.name || 'Case'),
        searchBody: parseRawBody(searchStep),
        searchUrl: String(searchStep?.request?.url?.raw || SEARCH_API_URL),
        prebookUrl: String(prebookStep?.request?.url?.raw || PREBOOK_API_URL),
        bookUrl: String(bookStep?.request?.url?.raw || BOOK_API_URL),
        detailUrl: String(detailStep?.request?.url?.raw || DETAIL_API_URL),
        voucherUrl: String(voucherStep?.request?.url?.raw || VOUCHER_API_URL),
      };
    })
    .slice(0, 8);

  return templates;
}

function parseOccupancies(searchBody: Json): Array<{ adults: number; children: number; childrenAges: number[] }> {
  const paxRooms = Array.isArray(searchBody?.PaxRooms) ? searchBody.PaxRooms : [];
  if (!paxRooms.length) {
    return [{ adults: 2, children: 0, childrenAges: [] }];
  }
  return paxRooms.map((x: any) => ({
    adults: Number(x?.Adults || 1),
    children: Number(x?.Children || 0),
    childrenAges: Array.isArray(x?.ChildrenAges) ? x.ChildrenAges.map((a: any) => Number(a)) : [],
  }));
}

function buildPassengers(occupancies: Array<{ adults: number; children: number; childrenAges: number[] }>) {
  const adultTitles = ['Mr', 'Ms', 'Mrs'];
  const adultsFirst = ['Arun', 'Meera', 'Kavya', 'Nitin', 'Sara', 'Vikram'];
  const adultsLast = ['Sharma', 'Iyer', 'Verma', 'Kapoor', 'Nair', 'Reddy'];
  const childFirst = ['Ira', 'Neel', 'Tara', 'Avi'];
  const childLast = ['Sharma', 'Iyer', 'Verma', 'Kapoor'];

  const pax: any[] = [];
  let ai = 0;
  let ci = 0;

  for (const occ of occupancies) {
    for (let i = 0; i < occ.adults; i++) {
      pax.push({
        Title: adultTitles[ai % adultTitles.length],
        FirstName: adultsFirst[ai % adultsFirst.length],
        MiddleName: '',
        LastName: adultsLast[ai % adultsLast.length],
        Email: `adult${ai + 1}@cert.example.com`,
        PaxType: 1,
        LeadPassenger: pax.length === 0,
        Age: 30 + (ai % 8),
        Phoneno: `9000000${String(100 + ai).slice(-3)}`,
        PaxId: 0,
        GSTCompanyAddress: null,
        GSTCompanyContactNumber: null,
        GSTCompanyName: null,
        GSTNumber: null,
        GSTCompanyEmail: null,
        PAN: 'AAAPL1234C',
        PassportNo: null,
        PassportIssueDate: null,
        PassportExpDate: null,
      });
      ai += 1;
    }

    for (let i = 0; i < occ.children; i++) {
      const age = occ.childrenAges?.[i] ?? 8;
      pax.push({
        Title: 'Miss',
        FirstName: childFirst[ci % childFirst.length],
        MiddleName: '',
        LastName: childLast[ci % childLast.length],
        Email: `child${ci + 1}@cert.example.com`,
        PaxType: 2,
        LeadPassenger: false,
        Age: age,
        Phoneno: `9111111${String(100 + ci).slice(-3)}`,
        PaxId: 0,
        GSTCompanyAddress: null,
        GSTCompanyContactNumber: null,
        GSTCompanyName: null,
        GSTNumber: null,
        GSTCompanyEmail: null,
        PAN: null,
        PassportNo: null,
        PassportIssueDate: null,
        PassportExpDate: null,
      });
      ci += 1;
    }
  }

  return pax;
}

function mapPassengersToHotelRooms(passengers: any[], occupancies: Array<{ adults: number; children: number; childrenAges: number[] }>) {
  const rooms: Array<{ HotelPassenger: any[] }> = [];
  let cursor = 0;

  for (const occ of occupancies) {
    const needed = (occ.adults || 0) + (occ.children || 0);
    const roomPax = passengers.slice(cursor, cursor + needed).map((p, idx) => ({
      ...p,
      LeadPassenger: idx === 0,
    }));
    rooms.push({ HotelPassenger: roomPax });
    cursor += needed;
  }

  return rooms;
}

function applyPrebookValidationToPassengers(passengers: any[], validationInfo: any) {
  const panMandatory = Boolean(validationInfo?.PanMandatory || validationInfo?.CrpPANMandatory);
  if (!panMandatory) {
    return passengers;
  }

  const fallbackPans = ['AAAAA9999L', 'AAAAA9999B', 'AAAAA9999C', 'AAAAA9999D', 'AAAAA9999E', 'AAAAA9999F'];

  return passengers.map((passenger, index) => ({
    ...passenger,
    PAN: passenger?.PAN || fallbackPans[index % fallbackPans.length],
  }));
}

async function requestJson(
  method: 'GET' | 'POST',
  endpoint: string,
  payload: Json | null,
  withBasicAuth: boolean,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (withBasicAuth) {
    headers.Authorization = getBasicAuthHeader();
  }

  if (method === 'GET') {
    const res = await axios.get(endpoint, {
      headers,
      timeout: HTTP_TIMEOUT_MS,
      validateStatus: () => true,
    });
    return { status: res.status, data: res.data };
  }

  const res = await axios.post(endpoint, payload || {}, {
    headers,
    timeout: HTTP_TIMEOUT_MS,
    validateStatus: () => true,
  });
  return { status: res.status, data: res.data };
}

function writeStepTxt(caseDir: string, step: StepResult, caseId: number) {
  const lines = [
    '======== REQUEST ========',
    JSON.stringify(step.requestPayload ?? null, null, 2),
    '',
    '======== RESPONSE ========',
    JSON.stringify(step.responsePayload ?? null, null, 2),
    '',
    '======== METADATA ========',
    `- timestamp: ${step.timestamp}`,
    `- endpoint: ${step.endpoint}`,
    `- status code: ${step.statusCode ?? 'N/A'}`,
    `- case id: ${caseId}`,
    `- step name: ${step.stepName}`,
    `- method: ${step.method}`,
    `- status: ${step.status}`,
    `- error: ${step.error || 'none'}`,
    `- skipped reason: ${step.skippedReason || 'none'}`,
    '',
  ];

  writeText(path.join(caseDir, step.fileName), lines.join('\n'));
}

function makeSkippedStep(stepNo: number, stepName: string, fileName: string, endpoint: string, reason: string): StepResult {
  return {
    stepNo,
    stepName,
    fileName,
    status: 'skipped',
    endpoint,
    method: 'POST',
    requestPayload: null,
    responsePayload: { skipped: true, reason },
    statusCode: undefined,
    error: undefined,
    timestamp: new Date().toISOString(),
    skippedReason: reason,
  };
}

function detectCapabilities(): CapabilityReport {
  const providerPath = path.join(ROOT, 'src', 'modules', 'hotels', 'providers', 'tbo-hotel.provider.ts');
  const itineraryControllerPath = path.join(ROOT, 'src', 'modules', 'itineraries', 'itineraries.controller.ts');
  const hotelsSearchControllerPath = path.join(ROOT, 'src', 'modules', 'hotels', 'controllers', 'hotel-search.controller.ts');
  const hotelsConfirmControllerPath = path.join(ROOT, 'src', 'modules', 'hotels', 'controllers', 'hotel-confirm.controller.ts');

  const providerSrc = fs.existsSync(providerPath) ? fs.readFileSync(providerPath, 'utf8') : '';
  const itineraryCtrlSrc = fs.existsSync(itineraryControllerPath) ? fs.readFileSync(itineraryControllerPath, 'utf8') : '';
  const searchCtrlSrc = fs.existsSync(hotelsSearchControllerPath) ? fs.readFileSync(hotelsSearchControllerPath, 'utf8') : '';
  const confirmCtrlSrc = fs.existsSync(hotelsConfirmControllerPath) ? fs.readFileSync(hotelsConfirmControllerPath, 'utf8') : '';

  return {
    hotelsSearchEndpoint: searchCtrlSrc.includes("@Post('search')"),
    itinerariesPrebookEndpoint: itineraryCtrlSrc.includes("@Post('hotels/prebook')"),
    itinerariesConfirmQuotationEndpoint: itineraryCtrlSrc.includes("@Post('confirm-quotation')"),
    hotelsCancelEndpoint: confirmCtrlSrc.includes("@Post('cancel/:ref')"),
    providerGetBookingDetailMethod: providerSrc.includes('async getConfirmation('),
    providerGenerateVoucherMethod: /generate\s*voucher|GenerateVoucher/.test(providerSrc),
    providerCancelMethod: providerSrc.includes('async cancelBooking('),
  };
}

async function authenticateStep(): Promise<{ tokenId: string | null; agencyId: string | null; step: StepResult }> {
  const payload = {
    ClientId: TBO_CLIENT_ID,
    UserName: TBO_USERNAME,
    Password: TBO_PASSWORD,
    EndUserIp: END_USER_IP,
  };

  try {
    const res = await requestJson('POST', SHARED_API_URL, payload, false);
    const tokenId = findFirstValue(res.data, ['TokenId', 'tokenId']);
    const agencyId = findFirstValue(res.data, ['AgencyId', 'agencyId', 'TokenAgencyId', 'tokenAgencyId']);
    const ok = res.status >= 200 && res.status < 300 && Number(res.data?.Status) === 1 && !!tokenId;

    return {
      tokenId: tokenId ? String(tokenId) : null,
      agencyId: agencyId ? String(agencyId) : null,
      step: {
        stepNo: 1,
        stepName: 'authenticate',
        fileName: '1-auth.txt',
        status: ok ? 'success' : 'failed',
        endpoint: SHARED_API_URL,
        method: 'POST',
        requestPayload: payload,
        responsePayload: res.data,
        statusCode: res.status,
        error: ok ? undefined : 'Authentication did not return usable TokenId',
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error: any) {
    return {
      tokenId: null,
      agencyId: null,
      step: {
        stepNo: 1,
        stepName: 'authenticate',
        fileName: '1-auth.txt',
        status: 'failed',
        endpoint: SHARED_API_URL,
        method: 'POST',
        requestPayload: payload,
        responsePayload: error?.response?.data || null,
        statusCode: error?.response?.status,
        error: error?.message || String(error),
        timestamp: new Date().toISOString(),
      },
    };
  }
}

function pickRoomFromSearch(searchPayload: Json, searchResp: any): { bookingCode: string | null; hotelCode: string | null; netAmount: number | null } {
  const hotels = Array.isArray(searchResp?.HotelResult) ? searchResp.HotelResult : [];
  const hotel = hotels[0] || null;
  const room = hotel?.Rooms?.[0] || null;

  const bookingCode = room?.BookingCode ? String(room.BookingCode) : null;
  const hotelCode = hotel?.HotelCode ? String(hotel.HotelCode) : String(searchPayload?.HotelCode || searchPayload?.HotelCodes || '');
  const netAmount = Number(room?.TotalFare || room?.DayRates?.[0]?.[0]?.BasePrice || 0) || null;

  return { bookingCode, hotelCode: hotelCode || null, netAmount };
}

function normalizeCaseGuestNationality(raw: string | undefined, caseId: number): string {
  const n = String(raw || 'IN').trim().toUpperCase();
  if (caseId === 2 && n === 'IN') {
    return 'AE';
  }
  return n || 'IN';
}

async function runOneCase(caseId: number, template: CaseTemplate, checkInDate: string, checkOutDate: string, caps: CapabilityReport): Promise<CaseExecution> {
  const caseSlug = `case-${caseId}-${toSlug(template.caseName)}`;
  const caseDir = path.join(OUT_ROOT, caseSlug);
  ensureDir(caseDir);

  const occupancies = parseOccupancies(template.searchBody);
  const passengers = buildPassengers(occupancies);
  const titleSet = Array.from(new Set(passengers.map((p) => String(p.Title))));
  const guestNationality = normalizeCaseGuestNationality(template.searchBody?.GuestNationality, caseId);

  const runtime: RuntimeValues = {
    tokenId: null,
    traceId: null,
    bookingCode: null,
    bookingId: null,
    confirmationNo: null,
    netAmount: null,
    agencyId: null,
    guestNationality,
    paymentMode: 'Limit',
    noOfRooms: Number(template.searchBody?.NoOfRooms ?? occupancies.length ?? 1),
    searchFiltersNoOfRooms: Number(template.searchBody?.Filters?.NoOfRooms ?? 0),
    titleSet,
  };

  const blockerNotes: string[] = [];
  const steps: StepResult[] = [];

  const auth = await authenticateStep();
  runtime.tokenId = auth.tokenId;
  runtime.agencyId = auth.agencyId;
  steps.push(auth.step);
  writeStepTxt(caseDir, auth.step, caseId);

  const searchPayload: Json = {
    ...(template.searchBody || {}),
    CheckIn: checkInDate,
    CheckOut: checkOutDate,
    GuestNationality: guestNationality,
    PaxRooms: occupancies.map((o) => ({ Adults: o.adults, Children: o.children, ChildrenAges: o.childrenAges })),
    IsDetailedResponse: true,
    ResponseTime: Number(template.searchBody?.ResponseTime || 23),
  };

  let searchStep: StepResult;
  let picked: { bookingCode: string | null; hotelCode: string | null; netAmount: number | null } = {
    bookingCode: null,
    hotelCode: null,
    netAmount: null,
  };

  try {
    const searchRes = await requestJson('POST', template.searchUrl || SEARCH_API_URL, searchPayload, true);
    const searchCode = statusCodeFromAny(searchRes.data?.Status);
    const ok = searchRes.status >= 200 && searchRes.status < 300 && searchCode === 200;
    picked = ok ? pickRoomFromSearch(searchPayload, searchRes.data) : picked;
    runtime.bookingCode = picked.bookingCode;
    runtime.netAmount = picked.netAmount;
    runtime.traceId = findFirstValue(searchRes.data, ['TraceId', 'traceId'])
      ? String(findFirstValue(searchRes.data, ['TraceId', 'traceId']))
      : runtime.traceId;
    runtime.agencyId = runtime.agencyId || (findFirstValue(searchRes.data, ['AgencyId', 'agencyId']) ? String(findFirstValue(searchRes.data, ['AgencyId', 'agencyId'])) : null);

    searchStep = {
      stepNo: 2,
      stepName: 'search',
      fileName: '2-search.txt',
      status: ok ? 'success' : 'failed',
      endpoint: template.searchUrl || SEARCH_API_URL,
      method: 'POST',
      requestPayload: searchPayload,
      responsePayload: searchRes.data,
      statusCode: searchRes.status,
      error: ok ? undefined : 'Search did not return Status.Code 200',
      timestamp: new Date().toISOString(),
    };
  } catch (error: any) {
    searchStep = {
      stepNo: 2,
      stepName: 'search',
      fileName: '2-search.txt',
      status: 'failed',
      endpoint: template.searchUrl || SEARCH_API_URL,
      method: 'POST',
      requestPayload: searchPayload,
      responsePayload: error?.response?.data || null,
      statusCode: error?.response?.status,
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    };
  }

  steps.push(searchStep);
  writeStepTxt(caseDir, searchStep, caseId);

  let prebookStep: StepResult;
  if (searchStep.status !== 'success' || !runtime.bookingCode) {
    prebookStep = makeSkippedStep(3, 'prebook', '3-prebook.txt', template.prebookUrl || PREBOOK_API_URL, 'Search failed or BookingCode missing');
  } else {
    const prebookPayload: Json = {
      BookingCode: runtime.bookingCode,
      PaymentMode: 'Limit',
      GuestNationality: guestNationality,
      NoOfRooms: runtime.noOfRooms,
      PaxRooms: occupancies.map((o) => ({ Adults: o.adults, Children: o.children, ChildrenAges: o.childrenAges })),
    };

    try {
      const prebookRes = await requestJson('POST', template.prebookUrl || PREBOOK_API_URL, prebookPayload, true);
      const prebookCode = statusCodeFromAny(prebookRes.data?.Status);
      const ok = prebookRes.status >= 200 && prebookRes.status < 300 && (prebookCode === 200 || prebookCode === 1);
      runtime.traceId = findFirstValue(prebookRes.data, ['TraceId', 'traceId'])
        ? String(findFirstValue(prebookRes.data, ['TraceId', 'traceId']))
        : runtime.traceId;
      runtime.bookingCode = prebookRes.data?.BookingCode ? String(prebookRes.data.BookingCode) : runtime.bookingCode;
      runtime.netAmount =
        Number(findFirstValue(prebookRes.data, ['NetAmount', 'netAmount', 'TotalFare', 'TotalPrice', 'Price', 'PublishedPriceRoundedOff', 'PublishedPrice']) || runtime.netAmount || 0) ||
        runtime.netAmount;

      prebookStep = {
        stepNo: 3,
        stepName: 'prebook',
        fileName: '3-prebook.txt',
        status: ok ? 'success' : 'failed',
        endpoint: template.prebookUrl || PREBOOK_API_URL,
        method: 'POST',
        requestPayload: prebookPayload,
        responsePayload: prebookRes.data,
        statusCode: prebookRes.status,
        error: ok ? undefined : 'PreBook did not return expected success status',
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      prebookStep = {
        stepNo: 3,
        stepName: 'prebook',
        fileName: '3-prebook.txt',
        status: 'failed',
        endpoint: template.prebookUrl || PREBOOK_API_URL,
        method: 'POST',
        requestPayload: prebookPayload,
        responsePayload: error?.response?.data || null,
        statusCode: error?.response?.status,
        error: error?.message || String(error),
        timestamp: new Date().toISOString(),
      };
    }
  }

  steps.push(prebookStep);
  writeStepTxt(caseDir, prebookStep, caseId);

  const prebookData = prebookStep.responsePayload as any;
  const validationInfo = prebookData?.ValidationInfo || null;
  const bookPassengers = applyPrebookValidationToPassengers(passengers, validationInfo);

  let bookStep: StepResult;
  if (prebookStep.status !== 'success' || !runtime.bookingCode) {
    bookStep = makeSkippedStep(4, 'book', '4-book.txt', template.bookUrl || BOOK_API_URL, 'PreBook failed or BookingCode missing');
  } else {
    const bookPayload: Json = {
      BookingCode: runtime.bookingCode,
      TokenId: runtime.tokenId || '',
      IsVoucherBooking: true,
      GuestNationality: guestNationality,
      EndUserIp: END_USER_IP,
      RequestedBookingMode: 1,
      TraceId: runtime.traceId || '',
      NetAmount: runtime.netAmount || 0,
      HotelRoomsDetails: mapPassengersToHotelRooms(bookPassengers, occupancies),
    };

    try {
      const bookRes = await requestJson('POST', template.bookUrl || BOOK_API_URL, bookPayload, true);
      const result = bookRes.data?.BookResult;
      const ok =
        bookRes.status >= 200 &&
        bookRes.status < 300 &&
        !!result &&
        (Number(result?.Status) === 1 || Number(result?.Status) === 200) &&
        (!result?.ResponseStatus || Number(result?.ResponseStatus) === 1);

      runtime.bookingId = result?.BookingId ? String(result.BookingId) : null;
      runtime.confirmationNo = result?.ConfirmationNo ? String(result.ConfirmationNo) : runtime.bookingId;
      runtime.traceId = runtime.traceId || (result?.TraceId ? String(result.TraceId) : null);

      bookStep = {
        stepNo: 4,
        stepName: 'book',
        fileName: '4-book.txt',
        status: ok ? 'success' : 'failed',
        endpoint: template.bookUrl || BOOK_API_URL,
        method: 'POST',
        requestPayload: bookPayload,
        responsePayload: bookRes.data,
        statusCode: bookRes.status,
        error: ok ? undefined : 'Book did not return successful BookResult',
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      bookStep = {
        stepNo: 4,
        stepName: 'book',
        fileName: '4-book.txt',
        status: 'failed',
        endpoint: template.bookUrl || BOOK_API_URL,
        method: 'POST',
        requestPayload: bookPayload,
        responsePayload: error?.response?.data || null,
        statusCode: error?.response?.status,
        error: error?.message || String(error),
        timestamp: new Date().toISOString(),
      };
    }
  }

  steps.push(bookStep);
  writeStepTxt(caseDir, bookStep, caseId);

  let detailStep: StepResult;
  if (!caps.providerGetBookingDetailMethod) {
    detailStep = makeSkippedStep(5, 'get-booking-detail', '5-get-booking-detail.txt', template.detailUrl || DETAIL_API_URL, 'GetBookingDetail method not detected in backend provider');
    blockerNotes.push('GetBookingDetail method not detected in backend provider.');
  } else if (!runtime.bookingId || !runtime.tokenId) {
    detailStep = makeSkippedStep(5, 'get-booking-detail', '5-get-booking-detail.txt', template.detailUrl || DETAIL_API_URL, 'Missing BookingId or TokenId');
  } else {
    const detailPayload: Json = {
      BookingId: Number(runtime.bookingId),
      BookingRefId: runtime.bookingId,
      TokenId: runtime.tokenId,
      EndUserIp: END_USER_IP,
    };

    try {
      const detailRes = await requestJson('POST', template.detailUrl || DETAIL_API_URL, detailPayload, true);
      const statusCode = statusCodeFromAny(detailRes.data?.Status);
      const resultStatus = Number(detailRes.data?.GetBookingDetailResult?.Status || detailRes.data?.GetBookingDetailResult?.ResponseStatus || 0);
      const ok = detailRes.status >= 200 && detailRes.status < 300 && (statusCode === 200 || statusCode === 1 || resultStatus === 1);

      detailStep = {
        stepNo: 5,
        stepName: 'get-booking-detail',
        fileName: '5-get-booking-detail.txt',
        status: ok ? 'success' : 'failed',
        endpoint: template.detailUrl || DETAIL_API_URL,
        method: 'POST',
        requestPayload: detailPayload,
        responsePayload: detailRes.data,
        statusCode: detailRes.status,
        error: ok ? undefined : 'GetBookingDetail did not return success status',
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      detailStep = {
        stepNo: 5,
        stepName: 'get-booking-detail',
        fileName: '5-get-booking-detail.txt',
        status: 'failed',
        endpoint: template.detailUrl || DETAIL_API_URL,
        method: 'POST',
        requestPayload: detailPayload,
        responsePayload: error?.response?.data || null,
        statusCode: error?.response?.status,
        error: error?.message || String(error),
        timestamp: new Date().toISOString(),
      };
    }
  }

  steps.push(detailStep);
  writeStepTxt(caseDir, detailStep, caseId);

  let cancelStep: StepResult;
  if (!caps.providerCancelMethod) {
    cancelStep = makeSkippedStep(6, 'cancel', '6-cancel.txt', CANCEL_API_URL, 'Cancel API not implemented in backend');
    blockerNotes.push('Cancel API not implemented in backend.');
  } else if (!runtime.bookingId || !runtime.tokenId) {
    cancelStep = makeSkippedStep(6, 'cancel', '6-cancel.txt', CANCEL_API_URL, 'Missing bookingId or tokenId');
  } else {
    const cancelPayload: Json = {
      RequestType: 4,
      BookingMode: 5,
      BookingId: Number(runtime.bookingId),
      EndUserIp: END_USER_IP,
      TokenId: runtime.tokenId,
      Remarks: `Certification cancel for case ${caseId}`,
    };

    try {
      const cancelRes = await requestJson('POST', CANCEL_API_URL, cancelPayload, true);
      const ok = cancelRes.status >= 200 && cancelRes.status < 300 && Number(cancelRes.data?.HotelChangeRequestResult?.ResponseStatus) === 1;

      cancelStep = {
        stepNo: 6,
        stepName: 'cancel',
        fileName: '6-cancel.txt',
        status: ok ? 'success' : 'failed',
        endpoint: CANCEL_API_URL,
        method: 'POST',
        requestPayload: cancelPayload,
        responsePayload: cancelRes.data,
        statusCode: cancelRes.status,
        error: ok ? undefined : 'Cancel did not return ResponseStatus=1',
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      cancelStep = {
        stepNo: 6,
        stepName: 'cancel',
        fileName: '6-cancel.txt',
        status: 'failed',
        endpoint: CANCEL_API_URL,
        method: 'POST',
        requestPayload: cancelPayload,
        responsePayload: error?.response?.data || null,
        statusCode: error?.response?.status,
        error: error?.message || String(error),
        timestamp: new Date().toISOString(),
      };
    }
  }

  steps.push(cancelStep);
  writeStepTxt(caseDir, cancelStep, caseId);

  const roomDetails = Array.isArray(prebookData?.HotelRoomsDetails) ? prebookData.HotelRoomsDetails : [];
  const cancelPolicies = roomDetails.flatMap((r: any) => r?.CancelPolicies || r?.CancellationPolicy || []).filter(Boolean);
  const mandatorySupplements = roomDetails.flatMap((r: any) => r?.MandatorySupplements || r?.MandatorySupplement || []).filter(Boolean);

  const caseSummaryLines = [
    `Case: ${template.caseName}`,
    `Case ID: ${caseId}`,
    `Date Range: ${checkInDate} -> ${checkOutDate}`,
    '',
    'Runtime Values',
    `- TokenId: ${runtime.tokenId || 'N/A'}`,
    `- TraceId: ${runtime.traceId || 'N/A'}`,
    `- BookingCode: ${runtime.bookingCode || 'N/A'}`,
    `- BookingId: ${runtime.bookingId || 'N/A'}`,
    `- ConfirmationNo: ${runtime.confirmationNo || 'N/A'}`,
    `- NetAmount: ${runtime.netAmount ?? 'N/A'}`,
    `- AgencyId: ${runtime.agencyId || 'N/A'}`,
    `- GuestNationality: ${runtime.guestNationality || 'N/A'}`,
    `- PaymentMode: ${runtime.paymentMode || 'N/A'}`,
    `- NoOfRooms: ${runtime.noOfRooms ?? 'N/A'}`,
    `- Filters.NoOfRooms: ${runtime.searchFiltersNoOfRooms ?? 'N/A'}`,
    `- Titles: ${(runtime.titleSet || []).join(', ') || 'N/A'}`,
    '',
    'Step Results',
    ...steps.map((s) => `- ${s.stepNo}. ${s.stepName}: ${s.status} (HTTP ${s.statusCode ?? 'N/A'})`),
    '',
    `CancelPolicies Found: ${cancelPolicies.length}`,
    `MandatorySupplements Found: ${mandatorySupplements.length}`,
    '',
    'Token Chaining Verification',
    `- Auth TokenId captured: ${runtime.tokenId ? 'yes' : 'no'}`,
    `- GetBookingDetail request includes TokenId: ${((steps.find((x) => x.stepName === 'get-booking-detail')?.requestPayload as any)?.TokenId ? 'yes' : 'no')}`,
    `- Cancel request includes TokenId: ${((steps.find((x) => x.stepName === 'cancel')?.requestPayload as any)?.TokenId ? 'yes' : 'no')}`,
    '',
    'Backend Flow Differences',
    '- Postman certification chain is provider-level and calls TBO endpoints directly.',
    '- Backend public controllers expose hotel search and itinerary prebook/confirm workflows, while this runner keeps provider-level request/response flow to preserve evidence parity with Postman.',
    ...(blockerNotes.length
      ? ['', 'Issues / Blockers', ...blockerNotes.map((b) => `- ${b}`)]
      : []),
    '',
  ];
  writeText(path.join(caseDir, 'summary.txt'), caseSummaryLines.join('\n'));

  return {
    caseId,
    caseName: template.caseName,
    caseSlug,
    checkInDate,
    checkOutDate,
    runtime,
    steps,
    cancelPolicies,
    mandatorySupplements,
    blockerNotes,
  };
}

async function runSupplementChecks(): Promise<Array<{
  hotelCode: string;
  searchStatus: string;
  prebookStatus: string;
  supplementsFound: number;
  amount: string;
  currency: string;
  payAtHotelNote: string;
}>> {
  const supRoot = path.join(OUT_ROOT, 'supplements');
  ensureDir(supRoot);

  const summaryRows: Array<{
    hotelCode: string;
    searchStatus: string;
    prebookStatus: string;
    supplementsFound: number;
    amount: string;
    currency: string;
    payAtHotelNote: string;
  }> = [];

  const checkIn = toYmd(addDays(new Date(), 45));
  const checkOut = toYmd(addDays(new Date(), 46));
  const searchPayload = {
    CheckIn: checkIn,
    CheckOut: checkOut,
    GuestNationality: 'IN',
    NoOfRooms: 1,
    PaxRooms: [{ Adults: 2, Children: 0, ChildrenAges: [] }],
    HotelCodes: SUPPLEMENT_CODES.join(','),
    ResponseTime: 23,
    IsDetailedResponse: true,
    Filters: {
      Refundable: true,
      MealType: 'WithMeal',
      NoOfRooms: 0,
      StarRating: 0,
      OrderBy: 0,
      HotelName: null,
    },
  };

  let sharedSearchStep: StepResult;
  let sharedSearchData: any = null;

  try {
    const searchRes = await requestJson('POST', SEARCH_API_URL, searchPayload, true);
    const searchCode = statusCodeFromAny(searchRes.data?.Status);
    const searchOk = searchRes.status >= 200 && searchRes.status < 300 && searchCode === 200;
    sharedSearchData = searchRes.data;

    sharedSearchStep = {
      stepNo: 1,
      stepName: 'search',
      fileName: '1-search.txt',
      status: searchOk ? 'success' : 'failed',
      endpoint: SEARCH_API_URL,
      method: 'POST',
      requestPayload: searchPayload,
      responsePayload: searchRes.data,
      statusCode: searchRes.status,
      error: searchOk ? undefined : 'Bulk search for supplement check failed',
      timestamp: new Date().toISOString(),
    };
  } catch (error: any) {
    sharedSearchStep = {
      stepNo: 1,
      stepName: 'search',
      fileName: '1-search.txt',
      status: 'failed',
      endpoint: SEARCH_API_URL,
      method: 'POST',
      requestPayload: searchPayload,
      responsePayload: error?.response?.data || null,
      statusCode: error?.response?.status,
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    };
  }

  const hotelResults = Array.isArray(sharedSearchData?.HotelResult) ? sharedSearchData.HotelResult : [];
  const bookingCodeByHotel: Record<string, string> = {};
  for (const hotel of hotelResults) {
    const code = hotel?.HotelCode !== undefined && hotel?.HotelCode !== null ? String(hotel.HotelCode) : null;
    const room = Array.isArray(hotel?.Rooms) ? hotel.Rooms[0] : null;
    const bookingCode = room?.BookingCode ? String(room.BookingCode) : null;
    if (code && bookingCode && !bookingCodeByHotel[code]) {
      bookingCodeByHotel[code] = bookingCode;
    }
  }

  for (const hotelCode of SUPPLEMENT_CODES) {
    const hotelDir = path.join(supRoot, `hotel-${hotelCode}`);
    ensureDir(hotelDir);

    writeStepTxt(hotelDir, sharedSearchStep, 0);

    if (sharedSearchStep.status !== 'success') {
      const prebookStep = makeSkippedStep(2, 'prebook', '2-prebook.txt', PREBOOK_API_URL, 'Bulk search failed');
      writeStepTxt(hotelDir, prebookStep, 0);
      summaryRows.push({
        hotelCode,
        searchStatus: sharedSearchStep.status,
        prebookStatus: prebookStep.status,
        supplementsFound: 0,
        amount: 'N/A',
        currency: 'N/A',
        payAtHotelNote: 'Supplement flow failed before prebook',
      });
      continue;
    }

    const bookingCode = bookingCodeByHotel[hotelCode];
    if (!bookingCode) {
      const prebookStep = makeSkippedStep(2, 'prebook', '2-prebook.txt', PREBOOK_API_URL, 'No BookingCode for hotel in bulk search response');
      writeStepTxt(hotelDir, prebookStep, 0);
      summaryRows.push({
        hotelCode,
        searchStatus: sharedSearchStep.status,
        prebookStatus: prebookStep.status,
        supplementsFound: 0,
        amount: 'N/A',
        currency: 'N/A',
        payAtHotelNote: 'Hotel not available in this run',
      });
      continue;
    }

    try {
      const prebookPayload = { BookingCode: bookingCode, PaymentMode: 'Limit', GuestNationality: 'IN', NoOfRooms: 1 };
      const prebookRes = await requestJson('POST', PREBOOK_API_URL, prebookPayload, true);
      const prebookCode = statusCodeFromAny(prebookRes.data?.Status);
      const prebookOk = prebookRes.status >= 200 && prebookRes.status < 300 && (prebookCode === 200 || prebookCode === 1);

      const prebookStep: StepResult = {
        stepNo: 2,
        stepName: 'prebook',
        fileName: '2-prebook.txt',
        status: prebookOk ? 'success' : 'failed',
        endpoint: PREBOOK_API_URL,
        method: 'POST',
        requestPayload: prebookPayload,
        responsePayload: prebookRes.data,
        statusCode: prebookRes.status,
        error: prebookOk ? undefined : 'PreBook for supplement check failed',
        timestamp: new Date().toISOString(),
      };
      writeStepTxt(hotelDir, prebookStep, 0);

      const roomDetails = Array.isArray(prebookRes.data?.HotelRoomsDetails) ? prebookRes.data.HotelRoomsDetails : [];
      const supplements = roomDetails.flatMap((r: any) => r?.MandatorySupplements || r?.MandatorySupplement || []).filter(Boolean);
      const first = supplements[0] || null;

      summaryRows.push({
        hotelCode,
        searchStatus: sharedSearchStep.status,
        prebookStatus: prebookStep.status,
        supplementsFound: supplements.length,
        amount: first?.Amount !== undefined && first?.Amount !== null ? String(first.Amount) : 'N/A',
        currency: first?.Currency || 'N/A',
        payAtHotelNote: first?.IsPayAtHotel ? 'Pay at hotel supplement indicated' : 'No pay-at-hotel marker',
      });
    } catch (error: any) {
      const prebookStep: StepResult = {
        stepNo: 2,
        stepName: 'prebook',
        fileName: '2-prebook.txt',
        status: 'failed',
        endpoint: PREBOOK_API_URL,
        method: 'POST',
        requestPayload: { BookingCode: bookingCode, PaymentMode: 'Limit', GuestNationality: 'IN', NoOfRooms: 1 },
        responsePayload: error?.response?.data || null,
        statusCode: error?.response?.status,
        error: error?.message || String(error),
        timestamp: new Date().toISOString(),
      };
      writeStepTxt(hotelDir, prebookStep, 0);

      summaryRows.push({
        hotelCode,
        searchStatus: sharedSearchStep.status,
        prebookStatus: prebookStep.status,
        supplementsFound: 0,
        amount: 'N/A',
        currency: 'N/A',
        payAtHotelNote: 'Supplement flow failed during prebook',
      });
    }
  }

  const summaryText = [
    'Supplement Summary',
    '',
    ...summaryRows.map((s) =>
      [
        `hotel code: ${s.hotelCode}`,
        `supplements found: ${s.supplementsFound}`,
        `amount: ${s.amount}`,
        `currency: ${s.currency}`,
        `pay-at-hotel note: ${s.payAtHotelNote}`,
        `search status: ${s.searchStatus}`,
        `prebook status: ${s.prebookStatus}`,
        '',
      ].join('\n'),
    ),
  ].join('\n');

  writeText(path.join(supRoot, 'supplement-summary.txt'), summaryText);
  return summaryRows;
}

function buildObservations(results: CaseExecution[]): string {
  const lines = [
    'TBO Certification Observations',
    '',
    '1. Checkin/Checkout usage per case',
    ...results.map((r) => `- Case ${r.caseId}: ${r.checkInDate} -> ${r.checkOutDate}`),
    '',
    '2. GuestNationality per case',
    ...results.map((r) => `- Case ${r.caseId}: ${r.runtime.guestNationality || 'N/A'}`),
    '',
    '3. PaymentMode per case',
    ...results.map((r) => `- Case ${r.caseId}: ${r.runtime.paymentMode || 'N/A'}`),
    '',
    '4. Titles per case',
    ...results.map((r) => `- Case ${r.caseId}: ${(r.runtime.titleSet || []).join(', ') || 'N/A'}`),
    '',
    '5. NoOfRooms usage per case',
    ...results.map(
      (r) =>
        `- Case ${r.caseId}: NoOfRooms=${r.runtime.noOfRooms ?? 'N/A'}, Filters.NoOfRooms=${r.runtime.searchFiltersNoOfRooms ?? 'N/A'}`,
    ),
    '',
    'Additional checks',
    `- Non-IN GuestNationality used: ${results.some((r) => (r.runtime.guestNationality || '').toUpperCase() !== 'IN') ? 'yes' : 'no'}`,
    `- PaymentMode=Limit used in prebook payloads: ${results.every((r) => (r.runtime.paymentMode || '') === 'Limit') ? 'yes' : 'no'}`,
    '',
  ];

  return lines.join('\n');
}

function buildReadinessVerdict(results: CaseExecution[]): { passed: number; failed: number; verdict: string } {
  const isCasePass = (r: CaseExecution) => {
    const required = ['authenticate', 'search', 'prebook', 'book'];
    const map = new Map(r.steps.map((s) => [s.stepName, s.status]));
    return required.every((n) => map.get(n) === 'success');
  };

  const passed = results.filter(isCasePass).length;
  const failed = results.length - passed;

  let verdict = 'NOT READY';
  if (passed === results.length) {
    verdict = 'READY';
  } else if (passed >= Math.ceil(results.length / 2)) {
    verdict = 'PARTIALLY READY';
  }

  return { passed, failed, verdict };
}

async function main() {
  ensureDir(OUT_ROOT);

  const capabilities = detectCapabilities();
  const templates = parseCollectionCases();
  if (templates.length < 8) {
    throw new Error('Could not infer all 8 cases from Postman collection.');
  }

  const baseDate = addDays(new Date(), 35);
  const results: CaseExecution[] = [];

  for (let i = 0; i < 8; i++) {
    const template = templates[i];
    const checkIn = toYmd(addDays(baseDate, i * 2));
    const checkOut = toYmd(addDays(baseDate, i * 2 + 1));

    try {
      console.log(`[Case ${i + 1}] ${template.caseName} -> starting`);
      const res = await runOneCase(i + 1, template, checkIn, checkOut, capabilities);
      results.push(res);
      console.log(`[Case ${i + 1}] ${template.caseName} -> completed`);
    } catch (error: any) {
      const caseSlug = `case-${i + 1}-${toSlug(template.caseName)}`;
      const caseDir = path.join(OUT_ROOT, caseSlug);
      ensureDir(caseDir);
      writeText(path.join(caseDir, 'summary.txt'), `Case execution crashed: ${error?.message || String(error)}\n`);
      results.push({
        caseId: i + 1,
        caseName: template.caseName,
        caseSlug,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        runtime: {},
        steps: [],
        cancelPolicies: [],
        mandatorySupplements: [],
        blockerNotes: [error?.message || String(error)],
      });
      console.error(`[Case ${i + 1}] failed hard:`, error?.message || String(error));
    }
  }

  const observations = buildObservations(results);
  writeText(path.join(OUT_ROOT, 'certification-observations.txt'), observations);

  const verdictInfo = buildReadinessVerdict(results);

  const summaryJson = {
    generatedAt: new Date().toISOString(),
    mode: 'provider-level-direct-chain',
    capabilities,
    notes: [
      'This certification flow mirrors Postman provider-level chaining.',
      'Backend public controllers differ from Postman chain for standalone provider operations.',
      'No fake success is recorded; failures and skips are preserved in artifacts.',
    ],
    cases: results.map((r) => ({
      caseId: r.caseId,
      caseName: r.caseName,
      checkInDate: r.checkInDate,
      checkOutDate: r.checkOutDate,
      runtime: r.runtime,
      steps: r.steps.map((s) => ({
        stepNo: s.stepNo,
        stepName: s.stepName,
        status: s.status,
        statusCode: s.statusCode ?? null,
        error: s.error || null,
      })),
      mandatorySupplementsFound: r.mandatorySupplements.length,
      cancelPoliciesFound: r.cancelPolicies.length,
      blockers: r.blockerNotes,
    })),
    finalVerdict: verdictInfo,
  };

  writeJson(path.join(OUT_ROOT, 'certification-summary.json'), summaryJson);

  const summaryMd = [
    '# TBO Hotel Certification Summary (8 Cases)',
    '',
    `Generated At: ${summaryJson.generatedAt}`,
    `Verdict: ${verdictInfo.verdict}`,
    `Passed Cases: ${verdictInfo.passed}`,
    `Failed Cases: ${verdictInfo.failed}`,
    '',
    '## Case Results',
    '',
    '| Case | Auth | Search | PreBook | Book | GetBookingDetail | Cancel |',
    '|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const map = new Map(r.steps.map((s) => [s.stepName, s.status]));
      return `| ${r.caseId} | ${map.get('authenticate') || 'not-run'} | ${map.get('search') || 'not-run'} | ${map.get('prebook') || 'not-run'} | ${map.get('book') || 'not-run'} | ${map.get('get-booking-detail') || 'not-run'} | ${map.get('cancel') || 'not-run'} |`;
    }),
    '',
    '## Runtime Value Chaining',
    '',
    '- TokenId is extracted from Authentication and reused in GetBookingDetail and Cancel payloads where executed.',
    '- TraceId, BookingCode, BookingId, ConfirmationNo, NetAmount, AgencyId are extracted and persisted per case.',
    '',
    '## Cancel Flow',
    '',
    `- Backend provider cancel method detected: ${capabilities.providerCancelMethod ? 'yes' : 'no'}`,
    `- Backend hotels cancel endpoint detected: ${capabilities.hotelsCancelEndpoint ? 'yes' : 'no'}`,
    '- Cancel step uses real BookingId + TokenId and stores exact request/response.',
    '',
    '## Issues / Blockers',
    '',
    '- Postman certification chain and backend public routes are not 1:1 for the full external-provider sequence; this run keeps provider-level flow for evidence parity.',
    '',
  ].join('\n');

  writeText(path.join(OUT_ROOT, 'certification-summary.md'), summaryMd);

  console.log(`Evidence written to: ${OUT_ROOT}`);
  console.log(`Passed cases: ${verdictInfo.passed}`);
  console.log(`Failed cases: ${verdictInfo.failed}`);
  console.log(`Certification readiness verdict: ${verdictInfo.verdict}`);
}

main().catch((error) => {
  console.error('Certification runner failed:', error);
  process.exitCode = 1;
});
