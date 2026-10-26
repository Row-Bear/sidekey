import { useEffect, useId, useRef, useState } from "react";
import type { FunctionInfo } from "@poc/core";
import { describeSignature, groupFunctions, matchesQuery } from "./functions";

/**
 * Chooses a contract function: type to filter, actions listed before read-only functions, each with its argument types
 * (and the contract's description when it has one). Functions the signer may already call are marked and come first.
 */
export function FunctionPicker({ functions, value, onChange, allowed, showReadOnly, onShowReadOnlyChange, loading }: {
  functions: FunctionInfo[];
  /** The chosen function's name. */
  value: string;
  onChange: (name: string) => void;
  /** Functions the chosen signer already has a rule for. */
  allowed?: ReadonlySet<string>;
  /** Whether read-only functions are listed. */
  showReadOnly: boolean;
  /** When given, a checkbox lets the user list them (the policy editor hides them by default, since a rule for one does nothing). */
  onShowReadOnlyChange?: (show: boolean) => void;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const holder = useRef<HTMLDivElement>(null);
  const listId = useId();

  const groups = groupFunctions(functions, allowed);
  const actions = groups.actions.filter((f) => matchesQuery(f, query));
  const reads = showReadOnly ? groups.reads.filter((f) => matchesQuery(f, query)) : [];
  const flat = [...actions, ...reads];
  const hiddenReads = showReadOnly ? 0 : groups.reads.length;
  const chosen = functions.find((f) => f.name === value) ?? null;

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const choose = (name: string) => {
    onChange(name);
    close();
  };

  // A click elsewhere closes the list.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!holder.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  // Typing narrows the list, so the highlight goes back to the top.
  useEffect(() => setActive(0), [query, showReadOnly]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return close();
    if (flat.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(flat[Math.min(active, flat.length - 1)].name);
    }
  };

  const item = (fn: FunctionInfo, index: number) => (
    <li
      key={fn.name}
      id={`${listId}-${index}`}
      role="option"
      aria-selected={fn.name === value}
      className={`fn-item${index === active ? " active" : ""}${fn.name === value ? " chosen" : ""}`}
      onMouseEnter={() => setActive(index)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => choose(fn.name)}
    >
      <span className="fn-line">
        <strong>{fn.name}</strong>
        <span className="muted small fn-args">({fn.args.map((a) => `${a.name}: ${a.type}${a.optional ? "?" : ""}`).join(", ")})</span>
        {allowed?.has(fn.name) && <span className="tag ok">allowed</span>}
      </span>
      {fn.doc.trim() !== "" && <span className="muted small fn-doc">{fn.doc.trim().split("\n")[0].slice(0, 140)}</span>}
    </li>
  );

  return (
    <div className="fn-picker" ref={holder}>
      <button
        type="button"
        className="fn-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={functions.length === 0}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="fn-chosen">
          {chosen ? describeSignature(chosen) : loading ? "Loading…" : functions.length === 0 ? "No functions found" : "Choose a function"}
        </span>
        <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="fn-pop">
          <input
            autoFocus
            type="search"
            className="fn-search"
            placeholder={`Search ${functions.length} functions…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={flat.length > 0 ? `${listId}-${Math.min(active, flat.length - 1)}` : undefined}
            aria-label="Search functions"
          />
          {onShowReadOnlyChange && (
            <label className="fn-toggle small">
              <input type="checkbox" checked={showReadOnly} onChange={(e) => onShowReadOnlyChange(e.target.checked)} />
              Show read-only functions{!showReadOnly && hiddenReads > 0 ? ` (${hiddenReads} hidden: they need no permission)` : ""}
            </label>
          )}
          <ul className="fn-list" id={listId} role="listbox" aria-label="Functions">
            {actions.length > 0 && (
              <li role="presentation" className="fn-group">
                Actions
              </li>
            )}
            {actions.map((fn, i) => item(fn, i))}
            {reads.length > 0 && (
              <li role="presentation" className="fn-group">
                Read-only
              </li>
            )}
            {reads.map((fn, i) => item(fn, actions.length + i))}
            {flat.length === 0 && (
              <li role="presentation" className="fn-empty muted small">
                {query.trim() ? `No function matches "${query.trim()}"` : "No functions to show"}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
