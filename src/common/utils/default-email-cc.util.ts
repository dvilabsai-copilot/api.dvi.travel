import { PrismaService } from '../../prisma.service';

type MailRecipient = string | { address?: string; name?: string };

type MailOptionsWithRecipients = {
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
};

function recipientList(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function emailAddresses(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[;,]/)
      .map((recipient) => {
        const angleAddress = recipient.match(/<\s*([^<>]+)\s*>/)?.[1];
        const address = (angleAddress || recipient).trim();
        return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(address)
          ? address.toLowerCase()
          : null;
      })
      .filter((address): address is string => address !== null);
  }

  if (value && typeof value === 'object' && 'address' in value) {
    return emailAddresses((value as MailRecipient & { address?: string }).address);
  }

  if (Array.isArray(value)) {
    return value.flatMap(emailAddresses);
  }

  return [];
}

function parseEmails(value: unknown): string[] {
  return emailAddresses(value);
}

/** Adds Global Settings' CC address to operational mail without duplicating recipients. */
export async function withGlobalSettingsCc<T extends MailOptionsWithRecipients>(
  prisma: PrismaService,
  options: T,
): Promise<T> {
  try {
    const settings = await prisma.dvi_global_settings.findFirst({
      where: { status: 1, deleted: 0 },
      orderBy: { global_settings_ID: 'asc' },
      select: { cc_email_id: true },
    });
    const configured = parseEmails(settings?.cc_email_id);
    if (configured.length === 0) return options;

    const existingRecipients = [options.to, options.cc, options.bcc]
      .flatMap(emailAddresses);
    const seen = new Set(existingRecipients);
    const additions = configured.filter((address) => {
      const normalized = emailAddresses(address)[0];
      if (!normalized) return false;
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });

    if (additions.length === 0) return options;
    return { ...options, cc: [...recipientList(options.cc), ...additions] } as T;
  } catch {
    // A settings lookup must not prevent the primary notification from sending.
    return options;
  }
}
