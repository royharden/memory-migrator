import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SETUP_MESSAGE } from "../lib/config.ts";

interface AuthGateProps {
  client: SupabaseClient | null;
  onLocalDemo: () => void;
  onSignedIn: () => void;
}

export function AuthGate({ client, onLocalDemo, onSignedIn }: AuthGateProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: { preventDefault: () => void }, mode: "sign-in" | "sign-up") {
    event.preventDefault();
    if (!client) return;
    setNotice(null);
    setError(null);
    if (password.length < 8) {
      setError("Use a password of at least 8 characters.");
      return;
    }
    setBusy(true);
    const credentials = { email: email.trim(), password };
    const result = mode === "sign-in" ? await client.auth.signInWithPassword(credentials) : await client.auth.signUp(credentials);
    setBusy(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    if (!result.data.session) {
      setNotice("No session yet. If email confirmation is on, confirm the message, then sign in. This screen will not invent a session.");
      return;
    }
    onSignedIn();
  }

  return (
    <section className="panel gate">
      <h2>Open a desk</h2>
      {client ? (
        <form className="stack" onSubmit={(event) => void submit(event, "sign-in")}>
          <label>
            Email
            <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label>
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          <div className="row-actions">
            <button className="primary" type="submit" disabled={busy}>Sign in</button>
            <button type="button" disabled={busy} onClick={(event) => void submit(event, "sign-up")}>Create account</button>
          </div>
        </form>
      ) : (
        <p>{SETUP_MESSAGE}</p>
      )}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {notice ? <p className="notice">{notice}</p> : null}
      <button type="button" className="primary" onClick={onLocalDemo}>Use local demo</button>
      <p className="muted">The local demo runs the same parser and review rules in this tab. Refreshing clears it.</p>
    </section>
  );
}
