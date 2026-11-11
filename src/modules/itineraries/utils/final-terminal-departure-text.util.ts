const TERMINAL_DESTINATION_PATTERN =
  /(airport|air\s*port|railway|rail\s*way|station|bus\s*stand|bus\s*station|terminal|terminus|junction|stn)\b/i;

export function getFinalTerminalDepartureText(input: {
  routeIndex: number;
  routeCount: number;
  destination: string;
  configuredText: string | null | undefined;
}): string | undefined {
  if (input.routeIndex !== input.routeCount - 1) return undefined;
  if (!TERMINAL_DESTINATION_PATTERN.test(input.destination)) return undefined;

  const text = input.configuredText?.trim();
  return text || undefined;
}
