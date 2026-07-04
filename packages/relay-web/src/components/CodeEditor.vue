<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { vue } from "@codemirror/lang-vue";

// A thin CodeMirror 6 wrapper: value in via v-model, save out via Mod-S. It owns NO file
// I/O — the parent (FileViewer) loads/saves. Kept a separate component so CM6 (a sizeable
// dependency) can be lazily chunked and so the editor is testable in isolation.
const props = defineProps<{ modelValue: string; filename?: string }>();
const emit = defineEmits<{ "update:modelValue": [string]; save: [] }>();

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;

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
    default: return [];
  }
}

// Theme mapped to the dashboard's CSS tokens so light/dark match without a second theme dep.
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

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        theme,
        ...langFor(props.filename),
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { emit("save"); return true; } }]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit("update:modelValue", u.state.doc.toString());
        }),
      ],
    }),
  });
});

// Reconcile an external value change (e.g. after a successful save re-reads) without
// clobbering in-progress typing: only replace when the prop differs from the current doc.
watch(() => props.modelValue, (v) => {
  if (view && v !== view.state.doc.toString()) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
  }
});

onBeforeUnmount(() => { view?.destroy(); view = null; });

// Exposed for tests (dispatch changes directly). Not part of the public contract.
defineExpose({ get view() { return view; } });
</script>

<template>
  <div ref="host" data-test="code-editor" class="h-full w-full overflow-auto"></div>
</template>
