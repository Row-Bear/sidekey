import { useEffect, useRef, useState } from "react";

/** Copies a value (an address or contract id) to the clipboard and says so for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // the clipboard can be unavailable (an insecure context, or permission denied); there is nothing useful to show
    }
  };

  return (
    <button type="button" className="ghost small-btn" aria-label={`Copy ${label}`} title={`Copy ${label}`} disabled={text === ""} onClick={() => void copy()}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
