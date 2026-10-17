import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { registerVisitor, type VisitorEntry } from "./api";

// The visitor's details stay in this browser so they sign in once; every new
// browser session is still logged on the server as a "return" visit.
const PROFILE_KEY = "dispatch-twin.visitor";
const SESSION_KEY = "dispatch-twin.visit-logged";

function readProfile(): VisitorEntry | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as VisitorEntry) : null;
  } catch {
    return null;
  }
}

function remember(key: string, value: string, storage: () => Storage) {
  try {
    storage().setItem(key, value);
  } catch {
    // Private windows can block storage; the visit is still logged on the server.
  }
}

function sessionLogged() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

const empty: VisitorEntry = { name: "", email: "", organisation: "", role: "", purpose: "" };

export function VisitorGate({ children }: { children: ReactNode }) {
  const [profile] = useState(readProfile);
  const [admitted, setAdmitted] = useState(profile !== null);
  const [form, setForm] = useState<VisitorEntry>(profile ?? empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile || sessionLogged()) return;
    registerVisitor({ ...profile, visit: "return" })
      .then(() => remember(SESSION_KEY, "1", () => sessionStorage))
      .catch(() => undefined);
  }, [profile]);

  if (admitted) return <>{children}</>;

  const set = (field: keyof VisitorEntry) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const entry: VisitorEntry = {
      name: form.name.trim(),
      email: form.email.trim(),
      organisation: form.organisation?.trim() || null,
      role: form.role?.trim() || null,
      purpose: form.purpose?.trim() || null,
    };
    try {
      await registerVisitor({ ...entry, visit: "first" });
      remember(PROFILE_KEY, JSON.stringify(entry), () => localStorage);
      remember(SESSION_KEY, "1", () => sessionStorage);
      setAdmitted(true);
    } catch {
      setError("We could not save your details. Check the name and email, then try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="visitor-gate">
      <form className="visitor-card" onSubmit={submit}>
        <span className="visitor-kicker">Dispatch Twin</span>
        <h1>Before you start</h1>
        <p>Tell us who you are so we know who has used the warehouse twin. You only need to do this once on this browser.</p>
        <label>
          Full name *
          <input required minLength={2} maxLength={120} autoComplete="name" value={form.name} onChange={set("name")} />
        </label>
        <label>
          Work email *
          <input required type="email" maxLength={200} autoComplete="email" value={form.email} onChange={set("email")} />
        </label>
        <div className="visitor-row">
          <label>
            Organisation
            <input maxLength={160} autoComplete="organization" value={form.organisation ?? ""} onChange={set("organisation")} />
          </label>
          <label>
            Role
            <input maxLength={120} autoComplete="organization-title" value={form.role ?? ""} onChange={set("role")} />
          </label>
        </div>
        <label>
          What brings you here?
          <textarea rows={3} maxLength={500} value={form.purpose ?? ""} onChange={set("purpose")} />
        </label>
        {error && <p className="visitor-error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? "Saving…" : "Enter the twin"}</button>
      </form>
    </main>
  );
}
