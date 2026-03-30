/**
 * Renders a shortcut string with ⇧ scaled up to match ⌘ visually.
 */
export function StyledShortcut({ text }: { text: string }) {
  if (!text.includes('\u21e7')) return <>{text}</>;

  const parts = text.split('\u21e7');
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && <span className="text-[1.3em] leading-none align-baseline">{'\u21e7'}</span>}
          {part}
        </span>
      ))}
    </>
  );
}
