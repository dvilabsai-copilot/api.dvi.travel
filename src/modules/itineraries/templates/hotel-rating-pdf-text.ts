import { existsSync } from 'node:fs';
import { join } from 'node:path';

// PDFKit's built-in Helvetica uses WinAnsi and cannot encode a Unicode star.
const ratingFonts = process.platform === 'win32'
  ? [join(process.env.SystemRoot || 'C:/Windows', 'Fonts', 'seguisym.ttf')]
  : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'];
const regularRatingFont = ratingFonts[0] && existsSync(ratingFonts[0]) ? ratingFonts[0] : undefined;
const boldRatingFont = ratingFonts[1] && existsSync(ratingFonts[1]) ? ratingFonts[1] : regularRatingFont;

export function getPdfHotelRatingText(label: string, category: unknown, bold = false): { text: string; font: string } {
  const fallbackFont = bold ? 'Helvetica-Bold' : 'Helvetica';
  const rating = Number(category);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !label.trim() || label === '--') {
    return { text: label, font: fallbackFont };
  }
  const font = bold ? boldRatingFont : regularRatingFont;
  return { text: `${label} (${rating}${font ? '★' : '-star'})`, font: font || fallbackFont };
}
