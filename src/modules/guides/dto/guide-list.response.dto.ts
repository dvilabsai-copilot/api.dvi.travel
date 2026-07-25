
// FILE: src/modules/guides/dto/guide-list.response.dto.ts
export type GuideListRow = {
  counter: number;
 modify: number; // id for action icons
  guide_name: string;
  mobile_number: string;
  email_id: string;
 status: number; // 1/0
};

export class GuideListResponseDto {
  data!: GuideListRow[];
  total?: number;
  page?: number;
  size?: number;
}
