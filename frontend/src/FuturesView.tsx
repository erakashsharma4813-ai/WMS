import { useEffect, useMemo, useRef, useState } from "react";

import type { Future, FuturesResult } from "./types";

type Props = {
  result: FuturesResult | null;
  error: string | null;
  disruptionLabel: string;
  clock: (minutes: number) => string;
  forkAt: number;
  onClose: () => void;
  onPlay: (best: Future, baseline: Future) => void;
  playing: boolean;
};

const PLAY_SECONDS = 7;

/** A tiny site plan per future: racks, docks and one dot per three trucks that left within their slot. */
function MiniSite({ value, max, tone }: { value: number; max: number; tone: string }) {
  const dots = Math.max(0, Math.round((value / Math.max(1, max)) * 12));
  return (
    <svg viewBox="0 0 64 30" className="mini-site" aria-hidden>
      <rect x="2" y="2" width="60" height="18" rx="2" className="mini-floor" />
      {[0, 1, 2].map((index) => <rect key={index} x={8 + index * 17} y="5" width="13" height="3" className="mini-rack" />)}
      {[0, 1, 2].map((index) => <rect key={index} x={8 + index * 17} y="11" width="13" height="3" className="mini-rack" />)}
      {[0, 1, 2, 3, 4, 5].map((index) => <rect key={index} x={14 + index * 7.4} y="17" width="4" height="3" className="mini-dock" />)}
      {Array.from({ length: 12 }, (_, index) => <circle key={index} cx={6 + index * 4.8} cy="26" r="1.3" className={index < dots ? `mini-dot ${tone}` : "mini-dot off"} />)}
    </svg>
  );
}

export function FuturesView({ result, error, disruptionLabel, clock, forkAt, onClose, onPlay, playing }: Props) {
  const [progress, setProgress] = useState(0);
  const started = useRef<number | null>(null);

  useEffect(() => {
    if (!result) return;
    started.current = null;
    setProgress(0);
    let frame = 0;
    const tick = (now: number) => {
      if (started.current === null) started.current = now;
      const next = Math.min(1, (now - started.current) / (PLAY_SECONDS * 1000));
      setProgress(next);
      if (next < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [result]);

  const steps = result?.futures[0]?.series.length ?? 1;
  const index = Math.min(steps - 1, Math.floor(progress * steps));
  const valueOf = (future: Future) => (progress >= 1 ? future.on_time : future.series[index] ?? 0);
  const baseline = result?.futures.find((future) => future.id === result.baseline);
  const max = useMemo(() => Math.max(1, ...(result?.futures.map((future) => future.on_time) ?? [1])), [result]);
  const live = useMemo(() => {
    if (!result) return [];
    return [...result.futures].sort((a, b) => valueOf(b) - valueOf(a) || a.late - b.late);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, index, progress >= 1]);
  const done = progress >= 1;
  const elapsed = (result?.horizon ?? 480) * progress;
  const best = result?.futures.find((future) => future.id === result.best);

  const groups = useMemo(() => {
    const map: Array<{ policy: string; span: number }> = [];
    result?.cols.forEach((col) => {
      const last = map[map.length - 1];
      if (last && last.policy === col.policy) last.span += 1;
      else map.push({ policy: col.policy, span: 1 });
    });
    return map;
  }, [result]);

  return (
    <div className="futures-overlay" role="dialog" aria-label="Parallel futures">
      <header className="futures-head">
        <div>
          <h2>{result ? result.futures.length : 24} parallel futures <span>· {disruptionLabel}</span></h2>
          <p>Forked at {clock(forkAt)} · every future sees the same disruption and the same task times (common random numbers) · only the decision differs · {result?.replications ?? 10} simulated days per future</p>
        </div>
        <div className="futures-clock">
          <b>{clock(forkAt + elapsed)} · +{Math.floor(elapsed / 60)}h {String(Math.round(elapsed % 60)).padStart(2, "0")}m of {Math.round((result?.horizon ?? 480) / 60)}h</b>
          <span><i style={{ width: `${progress * 100}%` }} /></span>
        </div>
        <button className="futures-skip" disabled={!result || done} onClick={() => setProgress(1)}>⏭ Skip to end</button>
        <button className="futures-close" onClick={onClose} title="Close">×</button>
      </header>

      {error && <div className="futures-error">{error}</div>}
      {!result && !error && <div className="futures-loading"><i />Forking the day at {clock(forkAt)} and simulating every decision…</div>}

      {result && (
        <div className="futures-body">
          <div className="futures-grid-wrap">
            <table className="futures-grid">
              <thead>
                <tr><th />{groups.map((group) => <th key={group.policy} colSpan={group.span} className="group">{group.policy}</th>)}</tr>
                <tr><th />{result.cols.map((col, column) => <th key={column} className="sub">{col.call}</th>)}</tr>
              </thead>
              <tbody>
                {result.rows.map((rowLabel, row) => (
                  <tr key={rowLabel}>
                    <th className="row-label">{rowLabel}</th>
                    {result.cols.map((_, column) => {
                      const future = result.futures.find((item) => item.row === row && item.col === column)!;
                      const value = valueOf(future);
                      const delta = Math.round((value - (baseline ? valueOf(baseline) : 0)) * 10) / 10;
                      const tone = future.do_nothing ? "base" : delta > 0.5 ? "up" : delta < -0.5 ? "down" : "flat";
                      const strength = Math.min(1, Math.abs(delta) / Math.max(4, max * 0.4));
                      const liveRank = live.findIndex((item) => item.id === future.id) + 1;
                      return (
                        <td key={column}>
                          <div className={`future-tile ${tone}${future.do_nothing ? " now" : ""}${done && future.id === result.best ? " best" : ""}`} style={{ ["--strength" as string]: strength }} title={`${future.label}\n${value.toFixed(1)} trucks on time · ${future.late} late · ${future.tat_hours} h average turnaround`}>
                            <span className="tile-id">{liveRank <= 3 ? <b>#{liveRank}</b> : null}{future.id}</span>
                            <MiniSite value={value} max={max} tone={tone} />
                            <span className="tile-value">{Math.round(value)}</span>
                            <span className="tile-delta">{future.do_nothing ? "NOW" : `${delta > 0 ? "+" : ""}${Math.round(delta)}`}</span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="futures-legend">Big number: trucks dispatched within their slot since the fork. Small number: difference against doing nothing. Green is better, red is worse.</p>
          </div>

          <aside className="futures-side">
            <div className="futures-rank">
              <div className="rank-head"><span>Rank</span><span>Decision</span><span>On time</span></div>
              {live.slice(0, 10).map((future, position) => (
                <div key={future.id} className={`rank-row${future.do_nothing ? " now" : ""}`}>
                  <b>{position + 1}</b><code>{future.id}</code><span>{future.do_nothing ? "Do nothing (current)" : future.label}</span><strong>{Math.round(valueOf(future))}</strong><em className={future.do_nothing ? "" : valueOf(future) >= (baseline ? valueOf(baseline) : 0) ? "up" : "down"}>{future.do_nothing ? "now" : `${valueOf(future) - (baseline ? valueOf(baseline) : 0) >= 0 ? "+" : ""}${Math.round(valueOf(future) - (baseline ? valueOf(baseline) : 0))}`}</em>
                </div>
              ))}
              {baseline && live.slice(0, 10).every((future) => future.id !== baseline.id) && (
                <div className="rank-row now separated"><b>{live.findIndex((future) => future.id === baseline.id) + 1}</b><code>{baseline.id}</code><span>Do nothing (current)</span><strong>{Math.round(valueOf(baseline))}</strong><em>now</em></div>
              )}
            </div>
            <div className="futures-status">
              {!done ? <span>Simulating {Math.round((result.horizon) / 60)} hours in every future…</span> : best && baseline && best.id === baseline.id ? (
                <p><b>Doing nothing is already the best plan.</b> No decision on the grid gets more trucks out within their slot after this disruption.</p>
              ) : best && baseline && best.delta <= 0.5 ? (
                <>
                  <p><b>No decision clearly helps.</b> Every future dispatches about {Math.round(baseline.on_time)} trucks within their slot. Fork later in the day, when the disruption bites harder, for a real difference.</p>
                  <button className="teal-action" disabled={playing} onClick={() => onPlay(best, baseline)}>{playing ? "Preparing replay…" : "▶ Play the top-ranked plan anyway"}</button>
                </>
              ) : best && baseline ? (
                <>
                  <p><b>Best:</b> {best.label}</p>
                  <p>{best.on_time} trucks within their slot against {baseline.on_time} if nothing changes ({best.delta >= 0 ? "+" : ""}{best.delta}); {best.late} late against {baseline.late}; cost of the day ₹{Math.round(best.cost_inr).toLocaleString("en-IN")} against ₹{Math.round(baseline.cost_inr).toLocaleString("en-IN")}.</p>
                  <button className="teal-action" disabled={playing} onClick={() => onPlay(best, baseline)}>{playing ? "Preparing replay…" : "▶ Play best plan against do nothing"}</button>
                </>
              ) : null}
            </div>
            <p className="futures-method">{result.method}</p>
          </aside>
        </div>
      )}
    </div>
  );
}
