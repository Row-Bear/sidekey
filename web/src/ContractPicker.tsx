import { useState } from "react";
import { shortAddress } from "./api";
import { type AddressBook, MAX_LABEL_LENGTH } from "./addressBook";

const OTHER = "other";

/** Picks a contract from the address book, or takes a pasted id that can be saved to it. */
export function ContractPicker({ value, onChange, book, error }: { value: string; onChange: (id: string) => void; book: AddressBook; error?: string | null }) {
  const [other, setOther] = useState(false);
  const [name, setName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const id = value.trim();
  const entry = book.entries.find((e) => e.id === id);
  const selected = entry && !other ? entry.id : OTHER;
  const canSave = selected === OTHER && /^C[A-Z2-7]{55}$/.test(id) && !entry;

  const choose = (next: string) => {
    setSaveError(null);
    if (next === OTHER) {
      setOther(true); // the field keeps the current id to edit
    } else {
      setOther(false);
      onChange(next);
    }
  };

  const save = () => {
    try {
      book.save(id, name);
      setName("");
      setOther(false);
      setSaveError(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="field contract-picker">
      <span className="field-label">Contract</span>
      <select value={selected} onChange={(e) => choose(e.target.value)} aria-label="Contract">
        {book.entries.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label} · {shortAddress(e.id)}
          </option>
        ))}
        <option value={OTHER}>Another contract (paste an id)…</option>
      </select>

      {entry && !other && (
        <div className="actions">
          {entry.note && <span className="muted small">{entry.note}</span>}
          {!entry.builtIn && (
            <>
              <input
                className="short"
                value={entry.label}
                maxLength={MAX_LABEL_LENGTH}
                onChange={(e) => book.rename(entry.id, e.target.value)}
                aria-label="Name in the address book"
              />
              <button className="ghost small-btn" onClick={() => book.remove(entry.id)}>
                Remove from list
              </button>
            </>
          )}
        </div>
      )}

      {selected === OTHER && (
        <>
          <input value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} placeholder="Contract id (C…)" aria-label="Contract id" />
          {canSave && (
            <div className="actions">
              <input
                className="short"
                value={name}
                maxLength={MAX_LABEL_LENGTH}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
                aria-label="Name to save it under"
              />
              <button className="ghost small-btn" disabled={name.trim() === ""} onClick={save}>
                Save to list
              </button>
              <span className="muted small">Kept in this browser.</span>
            </div>
          )}
          {saveError && <span className="error small">{saveError}</span>}
        </>
      )}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}
