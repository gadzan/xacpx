import { Prec, type Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// A github-light/dark-ish syntax palette. Colours are CSS variables (--c-syn-*) defined for
// light and .dark in style.css, so light/dark switches purely via CSS with no JS reconfigure
// — the same trick Shiki's dual-theme used. Prec.high so it overrides basicSetup's bundled
// defaultHighlightStyle (which is added at normal precedence inside `basicSetup`).
const githubHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.moduleKeyword], color: "var(--c-syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--c-syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--c-syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--c-syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "var(--c-syn-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: "var(--c-syn-type)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--c-syn-tag)" },
  { tag: [t.attributeName], color: "var(--c-syn-attribute)" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--c-syn-property)" },
  { tag: [t.constant(t.variableName), t.standard(t.name), t.macroName], color: "var(--c-syn-constant)" },
  { tag: [t.heading, t.strong], color: "var(--c-syn-heading)", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "var(--c-syn-link)", textDecoration: "underline" },
  { tag: [t.meta, t.processingInstruction], color: "var(--c-syn-comment)" },
  { tag: [t.invalid], color: "rgb(var(--c-danger))" },
]);

export const githubHighlight: Extension = Prec.high(syntaxHighlighting(githubHighlightStyle));
