import { IsIn, IsOptional, IsString } from "class-validator";

export type AccountsManagerStatus = "all" | "paid" | "due";
export type AccountsManagerComponentType =
  | "all"
  | "guide"
  | "hotspot"
  | "activity"
  | "hotel"
  | "vehicle"
 | "flight"; // flight will just return empty for now

export class AccountsManagerQueryDto {
  @IsOptional()
  @IsIn(["all", "paid", "due"])
  status?: AccountsManagerStatus;

  @IsOptional()
  @IsIn(["all", "guide", "hotspot", "activity", "hotel", "vehicle", "flight"])
  componentType?: AccountsManagerComponentType;

  @IsOptional()
  @IsString()
  quoteId?: string;

 // DD/MM/YYYY coming from UI
  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

 // Agent name substring (we match on dvi_agent.agent_name)
  @IsOptional()
  @IsString()
  agent?: string;

  @IsOptional()
  agentId?: number;

 // Free text search on quoteId + hotel/vendor name
  @IsOptional()
  @IsString()
  search?: string;
}
