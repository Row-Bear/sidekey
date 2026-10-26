/** A small "ⓘ" that explains something on hover or focus, so the page does not need a paragraph for it. */
export function Info({ text }: { text: string }) {
  return (
    <span className="info" title={text} aria-label={text} role="img" tabIndex={0}>
      ⓘ
    </span>
  );
}
