import { ref } from "vue";

// The menu key of the single file-tree context menu that may be open at a time.
// Every tree row and the workspace-root header share this ref, so opening one menu
// (via right-click or the more-actions button) implicitly closes any other: right-clicks
// do not fire the document `click` that ContextMenu listens for, so without this they
// would stack. The workspace root uses ROOT_MENU_KEY; a leading "/" can never collide
// with a workspace-relative path (those never start with a slash).
export const ROOT_MENU_KEY = "/__root__";
export const openMenuKey = ref<string | null>(null);
