export function interpolate(
  template: string,
  params?: Record<string, unknown>,
): string {
  if (params === undefined) return template;

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.hasOwn(params, name)) return match;

    const value = params[name];
    if (value === null || value === undefined) return match;

    try {
      return String(value);
    } catch {
      return match;
    }
  });
}
