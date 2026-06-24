import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Dual themes, statically (but dynamically-imported, so this whole module code-splits).
const THEMES = [
  import("@shikijs/themes/github-light"),
  import("@shikijs/themes/github-dark"),
];
// Hand-picked common languages. Each is a separate code-split chunk; all are fetched in
// parallel when THIS module is first imported (the import() exprs evaluate at module load),
// not per-language on demand. The whole module is itself loaded lazily via dynamic import().
const LANGS = [
  import("@shikijs/langs/shellscript"),
  import("@shikijs/langs/json"),
  import("@shikijs/langs/yaml"),
  import("@shikijs/langs/toml"),
  import("@shikijs/langs/xml"),
  import("@shikijs/langs/markdown"),
  import("@shikijs/langs/html"),
  import("@shikijs/langs/css"),
  import("@shikijs/langs/scss"),
  import("@shikijs/langs/javascript"),
  import("@shikijs/langs/typescript"),
  import("@shikijs/langs/jsx"),
  import("@shikijs/langs/tsx"),
  import("@shikijs/langs/vue"),
  import("@shikijs/langs/sql"),
  import("@shikijs/langs/graphql"),
  import("@shikijs/langs/c"),
  import("@shikijs/langs/cpp"),
  import("@shikijs/langs/rust"),
  import("@shikijs/langs/go"),
  import("@shikijs/langs/java"),
  import("@shikijs/langs/kotlin"),
  import("@shikijs/langs/python"),
  import("@shikijs/langs/php"),
  import("@shikijs/langs/ruby"),
  import("@shikijs/langs/swift"),
  import("@shikijs/langs/csharp"),
  import("@shikijs/langs/dockerfile"),
  import("@shikijs/langs/make"),
  import("@shikijs/langs/diff"),
];
const SHIKI_THEMES = { light: "github-light", dark: "github-dark" } as const;

export const langAlias: Record<string, string> = {
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", shell: "shellscript",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript",
  yml: "yaml", md: "markdown", htm: "html",
  py: "python", rs: "rust", kt: "kotlin", cs: "csharp", rb: "ruby",
  cc: "cpp", hpp: "cpp", h: "c",
  gql: "graphql", makefile: "make",
};

/** Map a file path (or bare language id) to a Shiki language id, defaulting to "text". */
export function resolveLang(pathOrLang?: string): string {
  if (!pathOrLang) return "text";
  const base = pathOrLang.includes(".") ? pathOrLang.split(".").pop()! : pathOrLang;
  const key = base.toLowerCase().trim();
  if (key === "text" || key === "plaintext" || key === "txt") return "text";
  return langAlias[key] ?? key;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: THEMES,
      langs: LANGS,
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

/** Highlight code to Shiki dual-theme HTML. Unknown languages fall back to plain text. */
export async function highlightToHtml(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter();
  const resolved = lang !== "text" && hl.getLoadedLanguages().includes(lang) ? lang : "text";
  return hl.codeToHtml(code, { lang: resolved, themes: SHIKI_THEMES, defaultColor: false });
}
