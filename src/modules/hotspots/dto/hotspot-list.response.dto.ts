// FILE: src/modules/hotspots/dto/hotspot-list.response.dto.ts

export interface HotspotListRow {
  counter: number;
 modify: number | string; // hotspot_ID
 hotspot_photo_url: string; // <img> HTML string (to mirror PHP) OR URL string
  hotspot_name: string;
  hotspot_priority: number | string;
 hotspot_locations: string; // HTML with <br>
 local_members: string; // HTML with <br>
 foreign_members: string; // HTML with <br>
}

export interface HotspotListResponseDto {
  data: HotspotListRow[];
}