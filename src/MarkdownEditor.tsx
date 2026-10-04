import { useEffect, useRef } from "react";
import { ink } from "ink-mde";
import type { Instance, VendorGrammar } from "ink-mde";

const FENCE = /^(?:---|\.\.\.)\s*$/;

/// SKILL.md files open with YAML frontmatter. Plain Markdown reads the block
/// as paragraph + `---` underline, i.e. a giant setext heading. Parse a leading
/// `---` … `---` block as an indented-code node instead, which ink-mde already
/// renders as a quiet monospace panel. Only the very first line can open it and
/// only when a closing fence exists, so ordinary horizontal rules are untouched.
const frontmatterGrammar: VendorGrammar = {
  parseBlock: [
    {
      name: "SkillFrontmatter",
      before: "HorizontalRule",
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false;
        // BlockContext keeps the document as `input` at runtime but leaves it
        // out of its typings; without it there is no safe way to look ahead.
        const input = (cx as unknown as { input?: { length: number; read(from: number, to: number): string } }).input;
        if (!input || typeof input.read !== "function") return false;
        const head = input.read(0, Math.min(input.length, 32_768));
        if (!/\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.test(head.slice(line.text.length))) return false;
        const start = cx.lineStart;
        while (cx.nextLine()) {
          if (FENCE.test(line.text)) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("CodeBlock", start, cx.prevLineEnd()));
        return true;
      },
    },
  ],
};

export function MarkdownEditor({
  value,
  onChange,
  theme,
  readOnly = false,
  hidden = false,
}: {
  value: string;
  onChange: (value: string) => void;
  theme: string;
  readOnly?: boolean;
  hidden?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Instance | null>(null);
  const lastValueRef = useRef(value);
  // The editor hook is registered once per mount; route it through a ref so it
  // always reaches the latest handler instead of the one captured at mount.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const mountRunRef = useRef(0);
  const appearance = theme === "light" ? "light" : theme === "system" ? systemAppearance() : "dark";

  useEffect(() => {
    let disposed = false;
    const mountRun = ++mountRunRef.current;
    async function mount() {
      if (!hostRef.current) return;
      hostRef.current.replaceChildren();
      const instance = await ink(hostRef.current, {
        doc: lastValueRef.current,
        interface: {
          appearance,
          attribution: false,
          toolbar: !readOnly,
          readonly: readOnly,
        },
        plugins: [{ type: "grammar", value: frontmatterGrammar }],
        hooks: {
          afterUpdate: (doc) => {
            // Programmatic updates (snapshot restore, external reload) echo
            // back through this hook; they are not user edits.
            if (doc === lastValueRef.current) return;
            lastValueRef.current = doc;
            onChangeRef.current(doc);
          },
        },
      });
      if (disposed || mountRunRef.current !== mountRun) {
        instance.destroy();
        return;
      }
      editorRef.current = instance;
      if (lastValueRef.current !== instance.getDoc()) instance.update(lastValueRef.current);
    }
    void mount();
    return () => {
      disposed = true;
      if (mountRunRef.current === mountRun) {
        editorRef.current?.destroy();
        editorRef.current = null;
        hostRef.current?.replaceChildren();
      }
    };
  }, [appearance, readOnly]);

  useEffect(() => {
    if (value === lastValueRef.current) return;
    lastValueRef.current = value;
    editorRef.current?.update(value);
  }, [value]);

  return <div className={hidden ? "markdown-editor-host is-hidden" : "markdown-editor-host"} ref={hostRef} aria-hidden={hidden || undefined} />;
}

function systemAppearance(): "light" | "dark" {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
