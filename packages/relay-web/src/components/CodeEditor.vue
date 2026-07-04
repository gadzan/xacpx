<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { EditorState, Compartment, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, keymap, Decoration, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { openSearchPanel } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { vue } from "@codemirror/lang-vue";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";
import { githubHighlight } from "../lib/cm-theme";

// The one file renderer: a single CodeMirror view that serves BOTH read (editable:false) and
// edit (editable:true), toggled via a Compartment — no remount, no re-highlight, no scroll
// jump. Owns NO file I/O; the parent (FileViewer) loads/saves and drives search/scroll.
const props = defineProps<{ modelValue: string; filename?: string; editable?: boolean; line?: number; lineRev?: number }>();
const emit = defineEmits<{ "update:modelValue": [string]; save: [] }>();

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
const editableComp = new Compartment();

function langFor(name?: string): Extension[] {
  const ext = (name ?? "").split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js": case "jsx": case "mjs": case "cjs": return [javascript({ jsx: ext === "jsx" })];
    case "ts": return [javascript({ typescript: true })];
    case "tsx": return [javascript({ typescript: true, jsx: true })];
    case "json": return [json()];
    case "html": case "htm": return [html()];
    case "css": case "scss": case "less": return [css()];
    case "md": case "markdown": return [markdown()];
    case "py": return [python()];
    case "yaml": case "yml": return [yaml()];
    case "vue": return [vue()];
    case "xml": return [xml()];
    case "sql": return [sql()];
    default: return [];
  }
}

function editableExt(on: boolean): Extension {
  return [EditorView.editable.of(on), EditorState.readOnly.of(!on)];
}

// Transient flash-a-line decoration used by scroll-to-line (search-hit clicks).
const flashEffect = StateEffect.define<number | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        deco = e.value == null ? Decoration.none : Decoration.set([Decoration.line({ class: "cm-flash-line" }).range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "rgb(var(--c-fg))", fontSize: "12.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: '"JetBrains Mono", ui-monospace, monospace', lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "transparent", color: "rgb(var(--c-fg-muted))", border: "none" },
  ".cm-activeLine": { backgroundColor: "rgb(var(--c-raised) / 0.5)" },
  ".cm-activeLineGutter": { backgroundColor: "rgb(var(--c-raised) / 0.5)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgb(var(--c-accent) / 0.25)" },
  ".cm-cursor": { borderLeftColor: "rgb(var(--c-accent))" },
});

let flashTimer: ReturnType<typeof setTimeout> | null = null;
function scrollToLine(n: number) {
  if (!view) return;
  const lineNo = Math.min(Math.max(n, 1), view.state.doc.lines);
  const pos = view.state.doc.line(lineNo).from;
  view.dispatch({ effects: [EditorView.scrollIntoView(pos, { y: "center" }), flashEffect.of(pos)] });
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => view?.dispatch({ effects: flashEffect.of(null) }), 1500);
}

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        theme,
        githubHighlight,
        flashField,
        ...langFor(props.filename),
        editableComp.of(editableExt(props.editable ?? false)),
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { emit("save"); return true; } }]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit("update:modelValue", u.state.doc.toString());
        }),
      ],
    }),
  });
  if (props.line != null && props.lineRev != null) scrollToLine(props.line);
});

// External value change (save re-read, cancel-revert) — replace only when it differs.
watch(() => props.modelValue, (v) => {
  if (view && v !== view.state.doc.toString()) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
  }
});
watch(() => props.editable, (on) => {
  view?.dispatch({ effects: editableComp.reconfigure(editableExt(on ?? false)) });
});
// Re-scroll whenever a new scroll request arrives (lineRev bumps each time).
watch(() => props.lineRev, () => {
  if (props.line != null && props.lineRev != null) scrollToLine(props.line);
});

onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer);
  view?.destroy();
  view = null;
});

function openSearch() { if (view) openSearchPanel(view); }
defineExpose({ get view() { return view; }, openSearch });
</script>

<template>
  <div ref="host" data-test="code-editor" class="h-full w-full overflow-auto"></div>
</template>
