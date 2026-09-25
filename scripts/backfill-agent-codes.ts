import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  getRandomAgentCodeCandidates,
  getAgentCodePrefix,
  withAgentCodeGenerationLock,
} from '../src/common/utils/agent-code.util';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

function normalizeAgentName(agentName: unknown): string {
  return String(agentName ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function chooseCode(
  agentName: unknown,
  currentCode: unknown,
  used: Set<string>,
  duplicateNames: Set<string>,
): string {
  const base = getAgentCodePrefix(agentName);
  const normalizedName = normalizeAgentName(agentName);
  const current = String(currentCode ?? '').trim().toUpperCase();
  const duplicate = duplicateNames.has(normalizedName);
  const targetLength: 3 | 4 = duplicate || (base.length === 3 && used.has(base)) ? 4 : 3;

  if (current.length === targetLength && current.startsWith(base) && !used.has(current)) {
    return current;
  }

  if (targetLength === 3 && base.length === 3 && !used.has(base)) {
    return base;
  }

  for (const candidate of getRandomAgentCodeCandidates(base, targetLength)) {
    if (!used.has(candidate)) return candidate;
  }

  throw new Error(`No available agent code remains for base ${base}`);
}

async function main() {
  const assignments = await prisma.$transaction(async (tx) =>
    withAgentCodeGenerationLock(tx as any, async () => {
      const agents = await tx.dvi_agent.findMany({
        orderBy: { agent_ID: 'asc' },
        select: {
          agent_ID: true,
          agent_name: true,
          agent_code: true,
        },
      });

      const configurations = await tx.dvi_agent_configuration.findMany({
        where: { deleted: 0 },
        orderBy: { agent_config_id: 'desc' },
        select: { agent_id: true, company_name: true },
      });
      const companyNames = new Map<number, string>();
      for (const configuration of configurations) {
        const agentId = Number(configuration.agent_id ?? 0);
        const companyName = String(configuration.company_name ?? '').trim();
        if (agentId > 0 && companyName && !companyNames.has(agentId)) {
          companyNames.set(agentId, companyName);
        }
      }

      const sourceNameFor = (agent: { agent_ID: number; agent_name: string | null }) =>
        companyNames.get(agent.agent_ID) || agent.agent_name;

      const used = new Set<string>();
      const nameCounts = new Map<string, number>();
      for (const agent of agents) {
        const name = normalizeAgentName(sourceNameFor(agent));
        if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
      const duplicateNames = new Set(
        [...nameCounts.entries()]
          .filter(([, count]) => count > 1)
          .map(([name]) => name),
      );
      const nextAssignments = agents.map((agent) => {
        const sourceName = sourceNameFor(agent);
        const agentCode = chooseCode(
          sourceName,
          agent.agent_code,
          used,
          duplicateNames,
        );
        used.add(agentCode);
        return {
          agent_ID: agent.agent_ID,
          agent_name: agent.agent_name,
          source_name: sourceName,
          previous_agent_code: agent.agent_code,
          agent_code: agentCode,
        };
      });

      const changedAssignments = nextAssignments.filter(
        (assignment) =>
          String(assignment.previous_agent_code ?? '').trim().toUpperCase() !==
          assignment.agent_code,
      );

      if (APPLY) {
        for (const assignment of changedAssignments) {
          await tx.dvi_agent.update({
            where: { agent_ID: assignment.agent_ID },
            data: { agent_code: assignment.agent_code, updatedon: new Date() },
          });
        }
      }

      return { all: nextAssignments, changed: changedAssignments };
    }),
  );

  console.log(
    `${APPLY ? 'Regenerated' : 'Would regenerate'} ${assignments.changed.length} ` +
    `agent codes (${assignments.all.length} checked).`,
  );
  for (const assignment of assignments.changed) {
    console.log(
      `${assignment.agent_ID}: ${assignment.agent_name || '(unnamed)'} ` +
      `[${assignment.source_name || '(agent name)'}] ` +
      `${assignment.previous_agent_code || '(empty)'} -> ${assignment.agent_code}`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
