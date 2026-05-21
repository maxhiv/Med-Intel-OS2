/**
 * ChatComposer — the textarea + Send/Cancel control pinned to the bottom of
 * the chat. Enter sends; Shift+Enter inserts a newline. Auto-resizes to ~6
 * lines. Shows the running session cost.
 */
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Send, Square } from "lucide-react";

export function ChatComposer({
  disabled,
  streaming,
  costUsd,
  onSend,
  onCancel,
}: {
  disabled: boolean;
  streaming: boolean;
  costUsd: number;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  function autoResize() {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || streaming || disabled) return;
    setText("");
    if (ref.current) ref.current.style.height = "auto";
    onSend(trimmed);
  }

  return (
    <div className="px-4 sm:px-6 py-4 max-w-3xl mx-auto w-full">
      <div className="flex items-end gap-2 border border-border rounded-lg bg-card focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/40">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            disabled
              ? "Start or pick a chat session…"
              : "Describe what you sell and where — e.g. 'mammography systems in Texas where the current unit is near end-of-life'"
          }
          disabled={disabled || streaming}
          rows={1}
          className="flex-1 resize-none bg-transparent border-0 outline-none px-4 py-3 text-sm disabled:opacity-60"
        />
        {streaming ? (
          <Button variant="ghost" size="sm" className="m-1.5 text-red-600" onClick={onCancel}>
            <Square className="h-4 w-4 mr-1" /> Stop
          </Button>
        ) : (
          <Button
            size="sm"
            className="m-1.5"
            disabled={!text.trim() || disabled}
            onClick={submit}
          >
            <Send className="h-4 w-4 mr-1" /> Send
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between mt-2 px-1 text-xs text-muted-foreground">
        <span>Enter to send · Shift+Enter for a newline</span>
        <span className="font-mono">Session cost: ${costUsd.toFixed(3)}</span>
      </div>
    </div>
  );
}
