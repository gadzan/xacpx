/** Directory of the built dashboard, or undefined when `dist/index.html` is absent. */
export function tryResolveWebRoot(moduleUrl?: string): string | undefined;

/** Directory of the built dashboard. Throws when the package was published without `dist/`. */
export function resolveWebRoot(moduleUrl?: string): string;
