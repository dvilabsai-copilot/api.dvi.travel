import type { Prisma, PrismaClient } from '@prisma/client';
import { isEmail } from 'class-validator';

const providerColumns = {
  offline: 'hotel_code',
  tbo: 'tbo_hotel_code',
  axisrooms: 'axisrooms_property_id',
  staah: 'staah_property_id',
  resavenue: 'resavenue_hotel_code',
} as const;

function catalogId(code: string): number | undefined {
  const id = Number(code);
  return /^\d+$/.test(code) && id > 0 && id <= 2_147_483_647 ? id : undefined;
}

const normalize = (value?: string | null) => value?.trim().toLowerCase() || '';

function contactEmails(value?: string | null): string[] {
  const emails = new Map<string, string>();
  for (const email of value?.split(/[;,\s]+/) ?? []) {
    if (email.length <= 254 && isEmail(email) && !emails.has(normalize(email))) {
      emails.set(normalize(email), email);
    }
  }
  return [...emails.values()].slice(0, 20);
}

function contactPhone(value?: string | null): string {
  return (value?.split(/[,;\r\n]+/) ?? [])
    .map((phone) => phone.trim())
    .find((phone) => phone.length <= 32 && /\d/.test(phone)) || '';
}

export async function loadOfflineHotelContacts(
  db: Pick<PrismaClient, 'dvi_hotel' | 'tbo_hotel_master'>,
  hotelKeys: string[],
) {
  const codesByProvider = new Map<string, string[]>();
  for (const key of new Set(hotelKeys)) {
    const separator = key.indexOf(':');
    if (separator < 1) continue;
    const provider = key.slice(0, separator);
    const code = key.slice(separator + 1);
    if (!code || !Object.prototype.hasOwnProperty.call(providerColumns, provider)) continue;
    const codes = codesByProvider.get(provider) ?? [];
    codes.push(code);
    codesByProvider.set(provider, codes);
  }

  const conditions: Prisma.dvi_hotelWhereInput[] = [];
  for (const [provider, column] of Object.entries(providerColumns)) {
    const codes = codesByProvider.get(provider);
    if (codes?.length) conditions.push({ [column]: { in: codes } });
  }
  const ids = (codesByProvider.get('offline') ?? []).flatMap((code) => catalogId(code) ?? []);
  if (ids.length) conditions.push({ hotel_id: { in: ids } });
  const tboCodes = codesByProvider.get('tbo') ?? [];
  const [catalog, vsr] = await Promise.all([
    conditions.length ? db.dvi_hotel.findMany({
      where: { AND: [{ OR: [{ deleted: false }, { deleted: null }] }, { OR: conditions }] },
      select: {
        hotel_id: true, hotel_code: true, tbo_hotel_code: true, axisrooms_property_id: true,
        staah_property_id: true, resavenue_hotel_code: true, hotel_email: true, hotel_mobile: true,
      },
    }) : [],
    tboCodes.length ? db.tbo_hotel_master.findMany({
      where: { tbo_hotel_code: { in: tboCodes } },
      select: { tbo_hotel_code: true, hotel_email: true, hotel_mobile: true },
    }) : [],
  ]);

  const contacts: Record<string, { emails: string[]; phone: string }> = {};
  for (const [provider, column] of Object.entries(providerColumns)) {
    for (const code of codesByProvider.get(provider) ?? []) {
      const id = provider === 'offline' ? catalogId(code) : undefined;
      const matched = catalog.filter((hotel) => id !== undefined
        ? hotel.hotel_id === id
        : normalize(hotel[column]) === code);
      const registered = matched.length === 1 ? matched[0] : undefined;
      const supplier = provider === 'tbo' ? vsr.find((hotel) => normalize(hotel.tbo_hotel_code) === code) : undefined;
      const emails = contactEmails(registered?.hotel_email);
      const phone = contactPhone(registered?.hotel_mobile) || contactPhone(supplier?.hotel_mobile);
      const availableEmails = emails.length ? emails : contactEmails(supplier?.hotel_email);
      if (availableEmails.length || phone) contacts[`${provider}:${code}`] = { emails: availableEmails, phone };
    }
  }
  return contacts;
}
