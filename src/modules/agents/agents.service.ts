// FILE: src/modules/agents/agents.service.ts

import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma.service";
import {
  AgentListItemDto,
  AgentWithCompanyDto,
} from "./dto/agent.dto";

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List agents (for dropdown), optionally filtered by travel expert.
   * Legacy: getAGENT_details(..., 'select')
   */
  async listAgents(travelExpertId?: number): Promise<AgentListItemDto[]> {
    const rows = await (travelExpertId
      ? this.prisma.$queryRaw<
          { agent_ID: number; agent_name: string | null }[]
        >`
        SELECT a.agent_ID, a.agent_name
        FROM dvi_agent AS a
        INNER JOIN dvi_users AS u ON a.agent_ID = u.agent_id
        WHERE a.status = '1'
          AND a.deleted = '0'
          AND u.userapproved = '1'
          AND a.travel_expert_id = ${travelExpertId}
        ORDER BY a.agent_name ASC
      `
      : this.prisma.$queryRaw<
          { agent_ID: number; agent_name: string | null }[]
        >`
        SELECT a.agent_ID, a.agent_name
        FROM dvi_agent AS a
        INNER JOIN dvi_users AS u ON a.agent_ID = u.agent_id
        WHERE a.status = '1'
          AND a.deleted = '0'
          AND u.userapproved = '1'
        ORDER BY a.agent_name ASC
      `);

    return rows.map((row) => ({
      id: row.agent_ID,
      name: row.agent_name ?? "",
    }));
  }

  /**
   * List agents with company info.
   * Legacy: getAGENT_details(..., 'agent_with_company')
   */
  async listAgentsWithCompany(
    travelExpertId?: number,
  ): Promise<AgentWithCompanyDto[]> {
    const rows = await (travelExpertId
      ? this.prisma.$queryRaw<
          {
            agent_ID: number;
            agent_name: string | null;
            company_name: string | null;
          }[]
        >`
        SELECT A.agent_ID,
               A.agent_name,
               COALESCE(C.company_name, 'NA') AS company_name
        FROM dvi_agent AS A
        LEFT JOIN dvi_agent_configuration AS C
          ON A.agent_ID = C.agent_id
        WHERE A.status = '1'
          AND A.deleted = '0'
          AND A.travel_expert_id = ${travelExpertId}
        ORDER BY A.agent_name ASC
      `
      : this.prisma.$queryRaw<
          {
            agent_ID: number;
            agent_name: string | null;
            company_name: string | null;
          }[]
        >`
        SELECT A.agent_ID,
               A.agent_name,
               COALESCE(C.company_name, 'NA') AS company_name
        FROM dvi_agent AS A
        LEFT JOIN dvi_agent_configuration AS C
          ON A.agent_ID = C.agent_id
        WHERE A.status = '1'
          AND A.deleted = '0'
        ORDER BY A.agent_name ASC
      `);

    return rows.map((row) => {
      const name = row.agent_name ?? "";
      const companyName = row.company_name ?? "NA";
      return {
        id: row.agent_ID,
        name,
        companyName,
        label: `${name} - ${companyName}`,
      };
    });
  }

  /**
   * Full label "agent_name agent_lastname" or '--'.
   * Legacy: getAGENT_details(..., 'label')
   */
  async getAgentLabel(agentId: number): Promise<string> {
    const agent = await this.prisma.dvi_agent.findFirst({
      where: {
        agent_ID: agentId,
        deleted: 0,
        status: 1,
      },
      select: {
        agent_name: true,
        agent_lastname: true,
      },
    });

    if (!agent) return "--";

    const fullName = `${agent.agent_name ?? ""} ${agent.agent_lastname ?? ""}`.trim();
    return fullName || "--";
  }
}
