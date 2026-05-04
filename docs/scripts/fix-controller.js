const fs = require('fs');
const file = 'c:\\wamp64\\www\\dvi_fullstack\\api.dvi.travel\\src\\modules\\vendors\\vendors.controller.ts';
const lines = fs.readFileSync(file, 'utf-8').split('\n');
// Lines 0..272 = up to end of local preview method (line 272 is "  }")
// Lines 273..353 = bad duplicate section to remove
// Lines 354..end = start of "@Get(':id/pricebook/outstation')" and remainder
const newMethods = [
  '',
  '  @Public()',
  "  @Get(':id/pricebook/outstation/preview')",
  "  @ApiOperation({ summary: 'Get outstation pricebook date-range preview (PHP ajax parity)' })",
  '  async getOutstationPricebookPreview(',
  "    @Param('id', ParseIntPipe) id: number,",
  "    @Query('startDate') startDate?: string,",
  "    @Query('endDate') endDate?: string,",
  '  ): Promise<any> {',
  '    return this.vendorsService.getVendorOutstationPricebookPreview(id, startDate, endDate);',
  '  }',
  '',
  '  @Public()',
  "  @Post(':id/local-pricebook')",
  "  @ApiOperation({ summary: 'Alias: update vendor local pricebook' })",
  '  async updateLocalPricebookAlias(',
  "    @Param('id', ParseIntPipe) id: number,",
  '    @Body() body: any,',
  '  ): Promise<any> {',
  '    return this.vendorsService.updateVendorLocalPricebook(id, body);',
  '  }',
  '',
];
// Find line 273 = first line after closing brace of local preview  
// Find line 355 = "@Public()" before "@Get(':id/pricebook/outstation')"
let keepEnd = 272; // inclusive (0-indexed), line 272 is "  }" closing local preview
let restStart = -1;
for (let i = 273; i < lines.length; i++) {
  if (lines[i].includes("@Get(':id/pricebook/outstation')") && i + 1 < lines.length && lines[i+1].includes("Get vendor outstation pricebook")) {
    restStart = i - 1; // include the @Public() before it
    break;
  }
}
console.log('keepEnd=' + keepEnd + ' restStart=' + restStart);
console.log('line keepEnd: ' + lines[keepEnd]);
console.log('line restStart: ' + lines[restStart]);
const result = [...lines.slice(0, keepEnd + 1), ...newMethods, ...lines.slice(restStart)];
fs.writeFileSync(file, result.join('\n'));
console.log('done lines=' + result.length);
