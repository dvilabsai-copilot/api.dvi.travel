
// FILE: src/modules/guides/dto/guide-form.options.dto.ts
export class GuideFormOptionsDto {
  countries!: { id: number; name: string }[];
  states!: { id: number; name: string; countryId: number }[];
  cities!: { id: number; name: string; stateId: number }[];
  languages!: { id: number; name: string }[];
 roles!: { id: number; name: string }[]; // e.g., Vendor/DVI/Others
 gstTypes!: { id: number; label: string }[]; // Included/Excluded/N.A.
 gstPercents!: { id: number; label: string; value: number }[]; // "18% GST %18"
 slots!: { id: number; label: string }[]; // Slot 1/2/3 as per PHP
}
