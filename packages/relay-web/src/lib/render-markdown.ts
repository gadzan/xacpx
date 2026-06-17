import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import remend from "remend";

// Single shared parser. html:false escapes any raw HTML in the markdown source,
// so agent output cannot inject markup; DOMPurify is a second, defense-in-depth pass
// over the rendered HTML.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

// Wrap tables in a horizontally scrollable container so a wide table scrolls within the
// message instead of overflowing the viewport — without display:block on the <table>,
// which would collapse its column layout into a stacked single column.
md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>';
md.renderer.rules.table_close = () => "</table></div>";

// Force every surviving link to open safely in a new tab. Registered once at module
// load; DOMPurify is a singleton and this app only sanitizes through this module.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
});

export interface RenderMarkdownOptions {
  /**
   * When true the source is run through `remend` first, which auto-closes
   * unterminated markdown (a half-typed `**bold`, an open code fence, a partial
   * link) so mid-stream frames render cleanly instead of swallowing the rest of
   * the message. Use for live streaming buffers; leave false for finalized text.
   */
  streaming?: boolean;
}

/** Render markdown to sanitized, XSS-safe HTML. */
export function renderMarkdown(text: string, options: RenderMarkdownOptions = {}): string {
  const source = options.streaming ? remend(text) : text;
  const rawHtml = md.render(source);
  return DOMPurify.sanitize(rawHtml);
}
