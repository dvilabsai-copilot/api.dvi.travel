import { randomInt } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const AGENT_CODE_LOCK = 'dvi_agent_code_generation';

type AgentCodeTransaction = {
  $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<any>;
  dvi_agent: {
    findMany: (args: any) => Promise<
      Array<{ agent_ID?: number; agent_name?: string | null; agent_code: string | null }>
    >;
  };
  dvi_agent_configuration?: {
    findMany: (args: any) => Promise<
      Array<{ agent_id?: number | null; company_name?: string | null }>
    >;
  };
};

/**
 * Derive the company-initial prefix used by an agent code.
 *
 * - A normal two-word name uses the first letter of each word, e.g. AH.
 * - A short acronym-like first word followed by another word uses its first
 *   two letters plus the next word's initial, e.g. DVI Holidays -> DVH.
 * - A single-word name keeps three recognizable letters, e.g. Tripozee -> TRP.
 */
export function getAgentCodePrefix(agentName: unknown): string {
  const rawWords = String(agentName ?? '').match(/[A-Za-z]+/g) ?? [];
  const words = rawWords.map((word) => word.toUpperCase());
  if (!words.length) return 'AX';

  const first = words[0];
  const second = words[1] ?? '';
  if (words.length === 1) {
    const consonants = first.replace(/[AEIOU]/g, '');
    return (consonants + first).slice(0, 3).padEnd(3, 'X');
  }

  const acronymLike = /^[A-Z]{2,3}$/.test(rawWords[0]) || first === 'DVI';
  if (acronymLike && second) {
    return `${first.slice(0, 2)}${second[0]}`;
  }

  return `${first[0]}${second[0]}`;
}

export function getRandomAgentCodeCandidates(
  prefix: string,
  targetLength: 3 | 4,
): string[] {
  const normalizedPrefix = String(prefix ?? '').toUpperCase();
  const suffixLength = targetLength - normalizedPrefix.length;
  if (suffixLength < 1 || suffixLength > 2) return [];

  const total = CODE_ALPHABET.length ** suffixLength;
  const candidates = Array.from({ length: total }, (_, index) => {
    let remainder = index;
    let suffix = '';
    for (let position = 0; position < suffixLength; position += 1) {
      suffix = CODE_ALPHABET[remainder % CODE_ALPHABET.length] + suffix;
      remainder = Math.floor(remainder / CODE_ALPHABET.length);
    }
    return `${normalizedPrefix}${suffix}`;
  });

  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [candidates[index], candidates[swapIndex]] = [
      candidates[swapIndex],
      candidates[index],
    ];
  }
  return candidates;
}

function normalizeAgentName(agentName: unknown): string {
  return String(agentName ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

/** Hold the application-level lock while choosing and writing an agent code. */
export async function withAgentCodeGenerationLock<T>(
  tx: AgentCodeTransaction,
  work: () => Promise<T>,
): Promise<T> {
  const lockRows = await tx.$queryRawUnsafe(
    'SELECT GET_LOCK(?, 10) AS acquired',
    AGENT_CODE_LOCK,
  );
  const acquired = Number(lockRows?.[0]?.acquired ?? 0);
  if (acquired !== 1) {
    throw new Error('Unable to acquire agent-code generation lock');
  }

  try {
    return await work();
  } finally {
    await tx.$queryRawUnsafe(
      'SELECT RELEASE_LOCK(?) AS released',
      AGENT_CODE_LOCK,
    );
  }
}

/**
 * Generate a unique agent code without relying on a database UNIQUE
 * constraint. A unique name gets its first three letters; a duplicate name
 * (or a three-letter collision) gets one random fourth letter.
 * Callers should invoke this while holding withAgentCodeGenerationLock().
 */
export async function generateUniqueAgentCode(
  tx: AgentCodeTransaction,
  agentName: unknown,
  excludeAgentId?: number,
): Promise<string> {
  const existing = await tx.dvi_agent.findMany({
    where: {
      agent_code: { not: null },
      ...(excludeAgentId && excludeAgentId > 0
        ? { agent_ID: { not: excludeAgentId } }
        : {}),
    },
    select: { agent_ID: true, agent_name: true, agent_code: true },
  });

  const used = new Set(
    existing
      .map((row) => String(row.agent_code ?? '').trim().toUpperCase())
      .filter(Boolean),
  );

  const configurations = tx.dvi_agent_configuration?.findMany
    ? await tx.dvi_agent_configuration.findMany({
        where: { deleted: 0 },
        orderBy: { agent_config_id: 'desc' },
        select: { agent_id: true, company_name: true },
      })
    : [];
  const companyNames = new Map<number, string>();
  for (const configuration of configurations) {
    const agentId = Number(configuration.agent_id ?? 0);
    const companyName = String(configuration.company_name ?? '').trim();
    if (agentId > 0 && companyName && !companyNames.has(agentId)) {
      companyNames.set(agentId, companyName);
    }
  }

  const sourceNameFor = (row: { agent_ID?: number; agent_name?: string | null }) =>
    (row.agent_ID ? companyNames.get(row.agent_ID) : undefined) || row.agent_name;
  const normalizedName = normalizeAgentName(agentName);
  const duplicateName = Boolean(normalizedName) && existing.some(
    (row) => normalizeAgentName(sourceNameFor(row)) === normalizedName,
  );
  const base = getAgentCodePrefix(agentName);
  const targetLength: 3 | 4 = duplicateName || used.has(base) ? 4 : 3;

  if (targetLength === 3 && base.length === 3) return base;

  for (const candidate of getRandomAgentCodeCandidates(base, targetLength)) {
    if (!used.has(candidate)) return candidate;
  }

  throw new Error(`No available agent code remains for prefix ${base}`);
}
