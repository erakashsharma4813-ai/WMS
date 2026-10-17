export type Zone = {
  zone_id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  capacity_pallets?: number;
  capacity_trucks?: number;
};

export type Rack = {
  rack_id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  levels: number;
  pallet_positions: number;
};

export type Dock = {
  dock_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  supported_truck_types?: string[];
};

export type Lane = {
  lane_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  capacity_pallets: number;
};

export type Layout = {
  site_id: string;
  plot: { width_m: number; height_m: number };
  zones: Zone[];
  rack_blocks: Rack[];
  docks: Dock[];
  marshalling_lanes: Lane[];
};

export type Scenario = {
  scenario_id: string;
  name: string;
  description: string;
};

export type ConfigResponse = {
  site: { site_name: string; timezone: string };
  layout: Layout;
  scenarios: Scenario[];
  resources: {
    equipment: Array<{ resource_id: string; type: string; status: string; home_zone?: string; loaded_speed_mps?: number; empty_speed_mps?: number; pickup_seconds?: number; drop_seconds?: number }>;
    fixed_resources: Array<{ resource_id: string; type: string; capacity: number }>;
    labour_pools: Array<{ pool_id: string; type: string }>;
  };
  rules: Record<string, unknown>;
  production: {
    production_lines: Array<{ line_id: string; product_group: string; pallets_per_hour: number }>;
    availability_profiles: Array<Record<string, unknown>>;
    planned_exceptions: Array<Record<string, unknown>>;
  };
  counts: Record<string, number>;
};

export type TraceEvent = {
  time: number;
  entity_id: string;
  entity_type: "truck" | "reach_truck" | "forklift" | "pallet" | "system";
  state: string;
  location_id: string | null;
  destination_id: string | null;
  case_id: string | null;
  label: string | null;
  severity: "normal" | "warning" | "critical";
  metadata: Record<string, string | number | null>;
};

export type HourlyMetric = {
  hour: number;
  truck_arrivals: number;
  completed_trucks: number;
  average_turnaround_minutes: number;
  picking_queue_peak: number;
  reach_truck_utilization: number;
  dock_utilization: number;
  stress_score: number;
};

export type SimulationResult = {
  run_id: string;
  mode: "historical_replay" | "dynamic_simulation";
  scenario_id: string;
  seed: number | null;
  start_timestamp: string;
  duration_minutes: number;
  kpis: {
    trucks: number;
    pallets: number;
    completed_trucks: number;
    average_turnaround_minutes: number;
    p90_turnaround_minutes: number;
    maximum_picking_queue: number;
    maximum_yard_queue: number;
    reach_truck_utilization: number;
    dock_utilization: number;
    worst_hour: string;
    primary_bottleneck: string;
  };
  hourly: HourlyMetric[];
  delay_analysis: Array<{
    stage: string;
    display_name: string;
    average_wait_minutes: number;
    p90_wait_minutes: number;
    maximum_wait_minutes: number;
    affected_entities: number;
    total_delay_minutes: number;
    severity: "normal" | "warning" | "critical";
    cause: string;
    recommendation: string;
  }>;
  shipment_schedule: Array<{
    shipment_id: string;
    planned_slot_minutes: number;
    simulated_arrival_minutes: number;
    production_ready_minutes: number;
    all_pallets_ready_minutes: number;
    pallets: number;
    priority: string;
    preferred_dock: string | null;
    assigned_dock: string | null;
    slot_status: string;
    truck_type?: string;
    transporter?: string;
  }>;
  trace: TraceEvent[];
  findings: string[];
  contract?: string | null;
  statistics?: RunStatistics | null;
  stress_points?: StressPoint[];
  stress_hourly?: StressHour[];
  scenario?: SimulationSettings | null;
  day_id?: string | null;
  representative_replication?: number | null;
};

export type ScenarioParams = Partial<{
  fillRate: number;
  policy: "gate" | "prepick";
  reachTrucks: number;
  docks: number;
  forklifts: number;
  lanes: number;
  callShare: number;
  congestionA: number;
  congestionF0: number;
}> & Record<string, number | string>;

export type SimulationSettings = {
  day_id: string | null;
  arrivals: "trace" | "random";
  chance: "det" | "sto";
  clock: 0 | 1 | 5;
  seed: number;
  replications: number;
  params: ScenarioParams;
  rules: Record<string, boolean>;
  demand_multiplier: number;
  live_as_of_minutes: number | null;
  disruptions?: Array<Record<string, number | string>>;
  decisions?: Array<{ at: number; params: Record<string, number>; label?: string }>;
  slot_overrides: Array<{
    shipment_id: string;
    arrival_offset_minutes: number;
    preferred_dock: string | null;
  }>;
};

export type RunStatistics = {
  replications: number;
  turnaround_hours: { mean: number; ci95: number };
  p90_turnaround_hours: number;
  evening_turnaround_hours: number;
  over_slot_pct: number;
  yard_full_days: number;
  first_yard_full_hour: number | null;
  trucks_completed_share: number;
  line_held_pallets: number;
  cost_inr: { mean: number; ci95: number; detention: number; penalties: number; line_stop: number };
  congestion_factor: number;
  slot_minutes: number;
};

export type StressPoint = {
  id: string;
  number: number;
  label: string;
  location: string;
  metric: string;
  amber: number;
  red: number;
  first_amber: number | null;
  first_red: number | null;
  red_minutes: number;
};

export type StressHour = { hour: number; metrics: Record<string, number>; levels: Record<string, "normal" | "amber" | "red"> };

export type DaySummary = {
  day_id: string;
  date: string;
  label: string;
  source: string;
  has_recording: boolean;
  trucks: number;
  pallets: number;
  peak_hour: string | null;
  arrivals_by_hour: Record<string, number>;
};

export type CardParameter = {
  key: string;
  label: string;
  value: number | string | { mean: number; tri: number[] };
  default: CardParameter["value"];
  changed: boolean;
  kind: "read" | "fitted" | "set";
  unit: string;
  group: string;
  source: string;
  status: string;
  fit?: string;
  min?: number;
  max?: number;
  options?: string[];
};

export type CardRule = { id: string; name: string; hooks: string[]; params: string[]; source: string; description: string; switchable: boolean; enabled: boolean };

export type ModelCard = { site_id: string; world_template: string; parameters: CardParameter[]; rules: CardRule[]; stress_points: Array<{ id: string; number: number; label: string; location: string; metric: string; amber: number; red: number }>; contract: string };

export type CompareResult = {
  baseline: { scenario: SimulationSettings; statistics: RunStatistics };
  variant: { scenario: SimulationSettings; statistics: RunStatistics };
  difference_hours: { mean: number; ci95: number };
  verdict: "real" | "within noise";
  method: string;
};

export type SweepResult = { curves: Array<{ policy: "gate" | "prepick"; points: Array<RunStatistics & { fill: number }> }> };

export type LeverResult = { levers: Array<RunStatistics & { lever: string; change: Record<string, number | string> }> };

export type DisruptionId = "reach_truck_down" | "rush_order" | "dock_down" | "gate_clerk_out";

export type Future = {
  id: string;
  row: number;
  col: number;
  label: string;
  decision: Record<string, number>;
  do_nothing: boolean;
  on_time: number;
  late: number;
  dispatched: number;
  tat_hours: number;
  series: number[];
  cost_inr: number;
  over_slot_pct: number;
  delta: number;
  delta_cost: number;
  rank: number;
};

export type FuturesResult = {
  fork_at: number;
  horizon: number;
  step: number;
  disruption: { id: DisruptionId; label: string; kind: string; duration: number };
  rows: string[];
  cols: Array<{ policy: string; call: string }>;
  replications: number;
  futures: Future[];
  ranking: string[];
  baseline: string;
  best: string;
  scenario: SimulationSettings;
  method: string;
};
