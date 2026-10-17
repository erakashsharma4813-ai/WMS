import { useMemo, useState } from "react";

import type { CardParameter, ModelCard, SimulationSettings } from "./types";

type Props = {
  card: ModelCard;
  settings: SimulationSettings;
  onChange: (params: SimulationSettings["params"], rules: SimulationSettings["rules"]) => void;
  onRun: () => void;
  running: boolean;
};

const KIND_LABEL = { read: "Read", fitted: "Fitted", set: "Set" } as const;
const KIND_HELP = {
  read: "Taken as it is from the past SAP day. Change it as a scenario edit.",
  fitted: "Estimated from many past days. Change it only with care: it is a calibration.",
  set: "A decision or a fact about the site. These are the levers.",
} as const;

function formatValue(row: CardParameter, value: CardParameter["value"]) {
  if (typeof value === "object" && value !== null) return `mean ${value.mean} · tri ${value.tri.join(" / ")}`;
  if (typeof value === "number" && row.unit === "share") return `${Math.round(value * 100)}%`;
  if (typeof value === "number" && row.unit === "minute of day") return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  if (typeof value === "number" && row.unit.startsWith("INR")) return `₹${value.toLocaleString("en-IN")} ${row.unit.replace("INR", "")}`.trim();
  return `${value}${row.unit && typeof value === "number" ? ` ${row.unit}` : ""}`;
}

export function ModelCardView({ card, settings, onChange, onRun, running }: Props) {
  const [kindFilter, setKindFilter] = useState<"all" | "read" | "fitted" | "set">("all");
  const groups = useMemo(() => {
    const map = new Map<string, CardParameter[]>();
    card.parameters.filter((row) => kindFilter === "all" || row.kind === kindFilter).forEach((row) => map.set(row.group, [...(map.get(row.group) ?? []), row]));
    return [...map.entries()];
  }, [card, kindFilter]);
  const changed = card.parameters.filter((row) => settings.params[row.key] !== undefined && settings.params[row.key] !== row.default);
  const offRules = card.rules.filter((rule) => settings.rules[rule.id] === false);

  const setParam = (row: CardParameter, raw: string) => {
    const next = { ...settings.params };
    const value = row.options ? raw : Number(raw);
    if (value === row.default || raw === "") delete next[row.key];
    else next[row.key] = value as number | string;
    onChange(next, settings.rules);
  };
  const setRule = (id: string, enabled: boolean) => {
    const next = { ...settings.rules };
    if (enabled) delete next[id];
    else next[id] = false;
    onChange(settings.params, next);
  };

  return (
    <section className="model-card-view">
      <header className="card-view-head">
        <div>
          <p className="eyebrow">MODEL CARD · {card.world_template}</p>
          <h2>Every number the simulation uses</h2>
          <p>Each value has a kind, a source and a status. Nothing is hidden: a result that looks wrong can be traced to one number or one rule here.</p>
        </div>
        <div className="card-view-actions">
          <div className="kind-filter">
            {(["all", "set", "read", "fitted"] as const).map((kind) => <button key={kind} className={kindFilter === kind ? "active" : ""} onClick={() => setKindFilter(kind)}>{kind === "all" ? "All" : KIND_LABEL[kind]}</button>)}
          </div>
          <button className="teal-action" disabled={running} onClick={onRun}>{running ? "Running…" : `Run with ${changed.length + offRules.length} change${changed.length + offRules.length === 1 ? "" : "s"}`}</button>
        </div>
      </header>

      <div className="card-legend">
        {(Object.keys(KIND_LABEL) as Array<keyof typeof KIND_LABEL>).map((kind) => <span key={kind}><i className={`kind-badge ${kind}`}>{KIND_LABEL[kind]}</i>{KIND_HELP[kind]}</span>)}
      </div>

      <div className="card-columns">
        <div className="card-parameters">
          {groups.map(([group, rows]) => (
            <div key={group} className="analytics-card card-group">
              <h3>{group}</h3>
              <table>
                <thead><tr><th>Parameter</th><th>Value</th><th>Kind</th><th>Source</th><th>Status</th></tr></thead>
                <tbody>
                  {rows.map((row) => {
                    const current = settings.params[row.key] ?? row.default;
                    const editable = typeof row.default !== "object";
                    const isChanged = settings.params[row.key] !== undefined && settings.params[row.key] !== row.default;
                    return (
                      <tr key={row.key} className={isChanged ? "changed" : ""}>
                        <td><b>{row.label}</b><small>{row.key}{row.fit ? ` · ${row.fit}` : ""}</small></td>
                        <td>
                          {editable ? (
                            row.options ? (
                              <select value={String(current)} onChange={(event) => setParam(row, event.target.value)}>{row.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>
                            ) : (
                              <span className="card-input"><input type="number" value={Number(current)} step={row.unit === "share" || row.key.startsWith("congestion") ? 0.01 : 1} min={row.min} max={row.max} onChange={(event) => setParam(row, event.target.value)} /><em>{formatValue(row, Number(current))}</em></span>
                            )
                          ) : (
                            <span className="card-fixed">{formatValue(row, row.value)}</span>
                          )}
                          {isChanged && row.kind === "fitted" && <small className="fit-warning">Changed a fitted value: results no longer match the calibration.</small>}
                        </td>
                        <td><i className={`kind-badge ${row.kind}`}>{KIND_LABEL[row.kind]}</i></td>
                        <td className="card-source">{row.source}</td>
                        <td><span className={`status-chip${row.status.startsWith("Assumption") ? " assumption" : ""}`}>{row.status}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        <aside className="card-side">
          <div className="analytics-card">
            <h3>Rules</h3>
            <p className="card-note">Every constraint is a plug-in rule. Switch one off to measure its effect; the engine falls back to the unconstrained behaviour.</p>
            <ul className="rule-list">
              {card.rules.map((rule) => {
                const enabled = settings.rules[rule.id] !== false;
                return (
                  <li key={rule.id} className={enabled ? "" : "off"}>
                    <label>
                      <input type="checkbox" checked={enabled} disabled={!rule.switchable} onChange={(event) => setRule(rule.id, event.target.checked)} />
                      <span><b>{rule.name}</b><small>{rule.description}</small><code>{rule.id} · {rule.hooks.join(", ") || "structural"} · params: {rule.params.join(", ")}</code></span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="analytics-card">
            <h3>Stress points</h3>
            <p className="card-note">Amber and red levels per stress point. The engine writes a meter event whenever a level changes.</p>
            <ol className="stress-definitions">
              {card.stress_points.map((point) => <li key={point.id}><b>{point.number}</b><span>{point.label}<small>{point.metric} · amber {point.amber} · red {point.red}</small></span></li>)}
            </ol>
          </div>
          <div className="analytics-card contract-card">
            <h3>Contract</h3>
            <p className="card-note">Scenario JSON in, event log JSON out. The screens read only the event log.</p>
            <code>{card.contract}</code>
          </div>
        </aside>
      </div>
    </section>
  );
}
