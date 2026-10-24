import { useEffect, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { ProfileState } from "../../supabase/functions/_shared/mm/model.ts";
import { getAccountClient, loadProfile, performAccount } from "../lib/account.ts";
import { SETUP_MESSAGE } from "../lib/config.ts";
import { Workspace } from "./Workspace.tsx";

type Stage = "loading" | "unconfigured" | "auth" | "recovery" | "consent" | "opening" | "ready";

/**
 * Account mode: explicit opt-in. Nothing is transferred on sign-in; the user must consent
 * first. Token refreshes never reload or overwrite in-progress review state.
 */
export function AccountMode({ onExit }: { onExit: () => void }) {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [profile, setProfile] = useState<ProfileState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | null = null;
    void getAccountClient().then(async (c) => {
      if (!active) return;
      if (!c) {
        setStage("unconfigured");
        return;
      }
      setClient(c);
      const { data } = await c.auth.getSession();
      if (!active) return;
      setSession(data.session);
      setStage(data.session ? "consent" : "auth");
      const sub = c.auth.onAuthStateChange((event, next) => {
        if (event === "PASSWORD_RECOVERY") setStage("recovery");
        else if (event === "SIGNED_OUT") {
          setSession(null);
          setProfile(null);
          setStage("auth");
        } else if (event === "SIGNED_IN") setSession(next);
        // TOKEN_REFRESHED / USER_UPDATED: keep the current review state untouched.
      });
      unsubscribe = () => sub.data.subscription.unsubscribe();
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  async function open() {
    if (!client) return;
    setStage("opening");
    setError(null);
    try {
      setProfile(await loadProfile(client));
      setStage("ready");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load your profile.");
      setStage("consent");
    }
  }

  if (stage === "ready" && client && profile) {
    return (
      <Workspace
        mode="account"
        initial={profile}
        perform={(state, action) => performAccount(client, state, action)}
        reload={async () => {
          try {
            return await loadProfile(client);
          } catch {
            return null;
          }
        }}
        onExit={onExit}
        banner={
          <section className="banner panel">
            <p>
              Signed in as {session?.user.email ?? "your account"}. Reviewed candidates, quote spans, IDs, hashes and decisions are stored privately; raw files, full messages and assistant text stay on this device.{" "}
              <button type="button" onClick={() => void client.auth.signOut()}>Sign out</button>
            </p>
          </section>
        }
      />
    );
  }

  return (
    <main className="shell">
      <section className="panel stack">
        <h2>Private account</h2>
        {stage === "loading" || stage === "opening" ? <p role="status">Loading…</p> : null}
        {stage === "unconfigured" ? <p>{SETUP_MESSAGE}</p> : null}
        {stage === "auth" && client ? <AuthForms client={client} onSignedIn={(s) => { setSession(s); setStage("consent"); }} /> : null}
        {stage === "recovery" && client ? <NewPassword client={client} onDone={() => setStage(session ? "consent" : "auth")} /> : null}
        {stage === "consent" ? (
          <div className="stack">
            <p>Before anything is uploaded, here is exactly what leaves this device when you apply an import or review a fact in account mode:</p>
            <ul>
              <li>Each candidate statement (slot, value, wording) and the exact quote span supporting it (at most 280 characters).</li>
              <li>Conversation and message IDs, hashes of the message text and source, offsets, timestamps, and your review decisions.</li>
            </ul>
            <p>Never uploaded: your export files, full messages, assistant replies, custom-instruction or “about me” text.</p>
            <button type="button" className="primary" onClick={() => void open()}>I consent — open my private profile</button>
          </div>
        ) : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <button type="button" onClick={onExit}>Back to mode choice</button>
      </section>
    </main>
  );
}

function AuthForms({ client, onSignedIn }: { client: SupabaseClient; onSignedIn: (session: Session) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(kind: "sign-in" | "sign-up") {
    setNotice(null);
    setError(null);
    if (password.length < 8) {
      setError("Use a password of at least 8 characters.");
      return;
    }
    setBusy(true);
    const credentials = { email: email.trim(), password };
    const result = kind === "sign-in" ? await client.auth.signInWithPassword(credentials) : await client.auth.signUp(credentials);
    setBusy(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    if (!result.data.session) {
      setNotice("Check your email to confirm the account, then sign in.");
      return;
    }
    onSignedIn(result.data.session);
  }

  async function recover() {
    setNotice(null);
    setError(null);
    if (!email.trim()) {
      setError("Enter your email first.");
      return;
    }
    setBusy(true);
    const { error: err } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
    setBusy(false);
    if (err) setError(err.message);
    else setNotice("If that address has an account, a recovery link is on its way.");
  }

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit("sign-in"); }}>
      <label>Email <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label>Password <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></label>
      <div className="row-actions">
        <button type="submit" className="primary" disabled={busy}>Sign in</button>
        <button type="button" disabled={busy} onClick={() => void submit("sign-up")}>Create account</button>
        <button type="button" disabled={busy} onClick={() => void recover()}>Forgot password</button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
    </form>
  );
}

function NewPassword({ client, onDone }: { client: SupabaseClient; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (password.length < 8) {
          setError("Use a password of at least 8 characters.");
          return;
        }
        void client.auth.updateUser({ password }).then(({ error: err }) => (err ? setError(err.message) : onDone()));
      }}
    >
      <label>New password <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></label>
      <button type="submit" className="primary">Set new password</button>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </form>
  );
}
