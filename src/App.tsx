import { useState } from "react";
import { emptyProfile } from "../supabase/functions/_shared/mm/model.ts";
import { AccountMode } from "./components/AccountMode.tsx";
import { Workspace } from "./components/Workspace.tsx";
import { publicConfig } from "./lib/config.ts";
import { applyLocal } from "./state/actions.ts";

type Mode = "choose" | "local" | "account";

/**
 * Mode chooser. Local mode never initializes auth, never refreshes a session and makes
 * no cloud/provider request: the account client is only loaded after the user picks
 * Account mode (dynamic import in src/lib/account.ts).
 */
export function App() {
  const [mode, setMode] = useState<Mode>("choose");
  const accountConfigured = publicConfig() !== null;

  if (mode === "local") {
    return (
      <Workspace
        mode="local"
        initial={emptyProfile(`local-${crypto.randomUUID()}`)}
        perform={async (state, action) => applyLocal(state, action)}
        onExit={() => setMode("choose")}
      />
    );
  }
  if (mode === "account") return <AccountMode onExit={() => setMode("choose")} />;

  return (
    <main className="shell">
      <header className="top">
        <p className="eyebrow">Portable memory migrator</p>
        <h1>Turn selected ChatGPT conversations into a profile you reviewed yourself.</h1>
        <p>Every exported statement has your approval and an exact quote from one of your own messages. Quotes show the words occurred; they do not prove they are true.</p>
      </header>
      <section className="panel stack">
        <h2>Choose a mode</h2>
        <div className="mode-grid">
          <article className="mode-card">
            <h3>Local mode</h3>
            <p>Everything stays in this tab's memory. No sign-in, no network request. Reloading or closing the tab loses unsaved work, so download your profile.</p>
            <button type="button" className="primary" onClick={() => setMode("local")}>Use local mode</button>
          </article>
          <article className="mode-card">
            <h3>Private account</h3>
            <p>Opt-in. After you consent, reviewed candidates, their quote spans, IDs, hashes and decisions are stored privately. Raw files, full messages, assistant text and custom-instruction text never leave this device.</p>
            <button type="button" onClick={() => setMode("account")} disabled={!accountConfigured}>Use a private account</button>
            {!accountConfigured ? <p className="muted">Account mode needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (public values). Local mode works without them.</p> : null}
          </article>
        </div>
        <p className="muted">Large-file performance is unverified. Built from a Dirty Mode construction run: the app has not been run or tested yet.</p>
      </section>
    </main>
  );
}
