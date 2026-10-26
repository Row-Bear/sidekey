/** A small rotating ring with a label, shown on a button while something is happening. */
export function Spinner({ label }: { label: string }) {
  return (
    <span className="working" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </span>
  );
}
