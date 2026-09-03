"use client";

/**
 * Renders the paint trace on the device that recorded it.
 *
 * The previous session is the interesting half: reproducing the failure means
 * launching normally, so the panel cannot have been asked for in advance.
 *
 * The copy button is not a convenience — forty timestamps have to leave the
 * phone somehow.
 */
import { useCallback, useEffect, useState } from "react";

import { readTrace } from "@/lib/trace";

export default function TracePanel() {
  const [{ now, before }, setLines] = useState<{
    now: string[];
    before: string[];
  }>({ now: [], before: [] });
  const [copied, setCopied] = useState(false);

  /* Polled rather than subscribed. The trace is a plain array written from
     the render path, and giving it a listener would mean the diagnostic could
     itself schedule React work in the middle of what it is diagnosing. A
     second is far below the rate anything here changes. */
  useEffect(() => {
    const read = () => setLines(readTrace());
    read();
    const id = window.setInterval(read, 1000);
    return () => window.clearInterval(id);
  }, []);

  const text = [
    "— sessione precedente —",
    ...(before.length ? before : ["(vuota)"]),
    "",
    "— sessione corrente —",
    ...(now.length ? now : ["(vuota)"]),
  ].join("\n");

  const copy = useCallback(() => {
    /* `writeText` needs a secure context and rejects when the document is not
       focused; the textarea fallback is what works inside an installed app on
       older WebKit. Neither is worth an error state — the lines are on screen
       and selectable either way. */
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    };
    navigator.clipboard?.writeText(text).then(done, () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        done();
      } finally {
        ta.remove();
      }
    });
  }, [text]);

  return (
    <div
      style={{
        position: "fixed",
        inset: "0 0 auto 0",
        zIndex: 9999,
        maxHeight: "70vh",
        overflow: "auto",
        /* Not themed on purpose. This has to stay readable whatever the app
           is doing, including when the palette is the thing that broke. */
        background: "rgba(8, 12, 18, 0.94)",
        color: "#d8e2ec",
        font: "10px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
        padding: "10px 12px calc(10px + env(safe-area-inset-bottom))",
        WebkitUserSelect: "text",
        userSelect: "text",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 11 }}>nembo · traccia</strong>
        <button
          type="button"
          onClick={copy}
          style={{
            font: "inherit",
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid #35506b",
            background: copied ? "#1d4b34" : "#16283c",
            color: "inherit",
          }}
        >
          {copied ? "copiato" : "copia tutto"}
        </button>
      </div>
      <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {text}
      </pre>
    </div>
  );
}
