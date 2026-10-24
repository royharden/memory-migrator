/** Placeholder until the account package (P6) lands. */
export function AccountMode({ onExit }: { onExit: () => void }) {
  return (
    <main className="shell">
      <section className="panel stack">
        <h2>Private account</h2>
        <p className="muted">Account mode is not wired yet.</p>
        <button type="button" onClick={onExit}>Back</button>
      </section>
    </main>
  );
}
