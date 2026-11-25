export function inferTboHouseboat(name: unknown): true | undefined {
  return /\bhouse[\s-]*boats?\b/i.test(String(name ?? '')) ? true : undefined;
}
