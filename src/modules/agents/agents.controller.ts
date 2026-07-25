// FILE: src/modules/agents/agents.controller.ts

import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { AgentsService } from "./agents.service";
import {
  AgentListItemDto,
  AgentWithCompanyDto,
} from "./dto/agent.dto";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

@ApiTags("agents")
@ApiBearerAuth()
@Controller("agents")
export class AgentsController {
  constructor(private readonly service: AgentsService) {}

 /**
   * GET /agents?travelExpertId=123
   * Simple agent dropdown.
 */
  @Get()
  @ApiOperation({
    summary: "List agents for dropdown",
    description:
      "Returns the list of agents, optionally filtered by travel expert.",
  })
  @ApiOkResponse({ type: AgentListItemDto, isArray: true })
  async listAgents(
    @Query("travelExpertId") travelExpertId?: string,
  ): Promise<AgentListItemDto[]> {
    return this.service.listAgents(
      travelExpertId ? Number(travelExpertId) : undefined,
    );
  }

 /**
   * GET /agents/with-company?travelExpertId=123
   * Agent + company label.
 */
  @Get("with-company")
  @ApiOperation({
    summary: "List agents with company info",
    description:
      "Returns agents with their company name and label 'Agent Name - Company'.",
  })
  @ApiOkResponse({ type: AgentWithCompanyDto, isArray: true })
  async listAgentsWithCompany(
    @Query("travelExpertId") travelExpertId?: string,
  ): Promise<AgentWithCompanyDto[]> {
    return this.service.listAgentsWithCompany(
      travelExpertId ? Number(travelExpertId) : undefined,
    );
  }

 /**
   * GET /agents/label?agentId=123
   * Returns "First Last" or '--'.
 */
  @Get("label")
  @ApiOperation({
    summary: "Get full agent label",
    description:
      "Returns the full agent label (agent_name + agent_lastname) or '--' if not found.",
  })
  @ApiOkResponse({ type: String })
  async getAgentLabel(
    @Query("agentId") agentId: string,
  ): Promise<string> {
    const parsedAgentId = Number(agentId);
    if (!Number.isFinite(parsedAgentId) || parsedAgentId <= 0) {
      throw new BadRequestException("agentId must be a positive number");
    }

    return this.service.getAgentLabel(parsedAgentId);
  }
}
