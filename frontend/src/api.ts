import type { CompareResult, ConfigResponse, DaySummary, DisruptionId, FuturesResult, LeverResult, ModelCard, SimulationResult, SimulationSettings, SweepResult } from "./types";

// Use the page's own origin by default. In development Vite proxies /api to
// FastAPI, so remote browsers (including macOS clients through ngrok) never
// try to call their own localhost.
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

const post = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const loadConfig = () => request<ConfigResponse>("/api/config");
export const loadReplay = () => request<SimulationResult>("/api/replay");
export const loadDays = () => request<DaySummary[]>("/api/days");
export const loadModelCard = (settings?: SimulationSettings) => (settings ? post<ModelCard>("/api/model-card", settings) : request<ModelCard>("/api/model-card"));
export const runSimulation = (settings: SimulationSettings) => post<SimulationResult>("/api/simulate", settings);
export const runCompare = (baseline: SimulationSettings, variant: SimulationSettings) => post<CompareResult>("/api/compare", { baseline, variant });
export const runSweep = (scenario: SimulationSettings, fills?: number[]) => post<SweepResult>("/api/sweep", { scenario, ...(fills ? { fills } : {}) });
export const runLevers = (scenario: SimulationSettings) => post<LeverResult>("/api/levers", scenario);
export const runFutures = (scenario: SimulationSettings, forkAt: number, disruption: DisruptionId) => post<FuturesResult>("/api/futures", { scenario, fork_at: forkAt, disruption });

export interface VisitorEntry {
  name: string;
  email: string;
  organisation?: string | null;
  role?: string | null;
  purpose?: string | null;
  visit?: "first" | "return";
}
export const registerVisitor = (entry: VisitorEntry) => post<{ recorded_at: string }>("/api/visitors", entry);
