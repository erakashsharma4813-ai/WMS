// Planar geometry in layout metres (x east, y north). The scene maps layout
// (x, y) to world (x - W/2, y - H/2) on the XZ plane, so a math angle measured
// counter-clockwise from east becomes rotation.y = -angle in three.js.

export type Vec2 = { x: number; y: number };

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const dist = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y);

export function angleLerp(from: number, to: number, t: number) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
export const smooth = (value: number) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

/** Trapezoidal velocity profile: accelerate, cruise, brake. Maps time fraction to distance fraction. */
export function trapezoid(u: number, accel = 0.2) {
  const t = clamp01(u);
  const peak = 1 / (1 - accel);
  if (t < accel) return 0.5 * peak * t * t / accel;
  if (t <= 1 - accel) return peak * (accel / 2 + (t - accel));
  const rest = 1 - t;
  return 1 - 0.5 * peak * rest * rest / accel;
}

/** Deterministic 0..1 hash so the same trace always renders the same choices. */
export function hash01(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function dedupe(points: Vec2[]) {
  const result: Vec2[] = [];
  points.forEach((point) => {
    const last = result[result.length - 1];
    if (!last || dist(last, point) > 0.05) result.push(point);
  });
  return result;
}

/** Replace each interior corner with a circular arc so vehicles corner smoothly. */
function fillet(points: Vec2[], radius: number) {
  if (points.length < 3 || radius <= 0) return points;
  const out: Vec2[] = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = out[out.length - 1];
    const b = points[i];
    const c = points[i + 1];
    const lab = dist(a, b);
    const lbc = dist(b, c);
    if (lab < 1e-3 || lbc < 1e-3) continue;
    const u1 = v((b.x - a.x) / lab, (b.y - a.y) / lab);
    const u2 = v((c.x - b.x) / lbc, (c.y - b.y) / lbc);
    const turn = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)));
    if (turn < 0.02) {
      out.push(b);
      continue;
    }
    const tangentLength = Math.min(radius * Math.tan(turn / 2), lab * 0.5, lbc * 0.5);
    const r = tangentLength / Math.tan(turn / 2);
    const p1 = v(b.x - u1.x * tangentLength, b.y - u1.y * tangentLength);
    const left = u1.x * u2.y - u1.y * u2.x > 0;
    const normal = left ? v(-u1.y, u1.x) : v(u1.y, -u1.x);
    const centre = v(p1.x + normal.x * r, p1.y + normal.y * r);
    const start = Math.atan2(p1.y - centre.y, p1.x - centre.x);
    const sweep = left ? turn : -turn;
    const steps = Math.max(3, Math.ceil(Math.abs(sweep) * r / 0.4));
    for (let step = 0; step <= steps; step += 1) {
      const angle = start + sweep * step / steps;
      out.push(v(centre.x + Math.cos(angle) * r, centre.y + Math.sin(angle) * r));
    }
  }
  out.push(points[points.length - 1]);
  return dedupe(out);
}

export type PathSample = { x: number; y: number; angle: number };

/** Arc-length parameterised polyline. Sampling beyond either end extrapolates along the end tangent. */
export class Path {
  readonly points: Vec2[];
  readonly cumulative: number[];
  readonly length: number;

  constructor(points: Vec2[], radius = 0) {
    const cleaned = dedupe(points);
    this.points = cleaned.length > 1 ? fillet(cleaned, radius) : [cleaned[0] ?? v(0, 0), cleaned[0] ?? v(0, 0)];
    this.cumulative = [0];
    for (let i = 1; i < this.points.length; i += 1) {
      this.cumulative.push(this.cumulative[i - 1] + dist(this.points[i - 1], this.points[i]));
    }
    this.length = this.cumulative[this.cumulative.length - 1];
  }

  private segmentAngle(index: number) {
    const a = this.points[index];
    const b = this.points[index + 1];
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  at(s: number): PathSample {
    const last = this.points.length - 1;
    if (this.length < 1e-6) return { ...this.points[0], angle: 0 };
    if (s <= 0) {
      const angle = this.segmentAngle(0);
      return { x: this.points[0].x + Math.cos(angle) * s, y: this.points[0].y + Math.sin(angle) * s, angle };
    }
    if (s >= this.length) {
      const angle = this.segmentAngle(last - 1);
      const extra = s - this.length;
      return { x: this.points[last].x + Math.cos(angle) * extra, y: this.points[last].y + Math.sin(angle) * extra, angle };
    }
    let low = 0;
    let high = last;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (this.cumulative[mid] <= s) low = mid;
      else high = mid;
    }
    const span = this.cumulative[high] - this.cumulative[low] || 1;
    const t = (s - this.cumulative[low]) / span;
    const a = this.points[low];
    const b = this.points[high];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  get startAngle() {
    return this.at(0.01).angle;
  }

  get endAngle() {
    return this.at(this.length - 0.01).angle;
  }
}

type Edge = { a: number; b: number; length: number };

/**
 * Indoor travel network built from axis-aligned aisle segments. Intersections
 * become nodes; arbitrary points (rack faces, lane ends) attach by projecting
 * onto the nearest edge, then Dijkstra finds the shortest aisle route.
 */
export class AisleGraph {
  private nodes: Vec2[] = [];
  private edges: Edge[] = [];
  private adjacency: Array<Array<{ to: number; length: number }>> = [];
  private cache = new Map<string, Vec2[]>();

  constructor(segments: Array<[Vec2, Vec2]>) {
    const key = (point: Vec2) => `${point.x.toFixed(2)}:${point.y.toFixed(2)}`;
    const index = new Map<string, number>();
    const nodeFor = (point: Vec2) => {
      const id = key(point);
      if (!index.has(id)) {
        index.set(id, this.nodes.length);
        this.nodes.push(point);
        this.adjacency.push([]);
      }
      return index.get(id)!;
    };
    segments.forEach(([a, b], i) => {
      const along: Vec2[] = [a, b];
      segments.forEach(([c, d], j) => {
        if (i === j) return;
        const hit = intersect(a, b, c, d);
        if (hit) along.push(hit);
      });
      const horizontal = Math.abs(a.y - b.y) < 1e-6;
      along.sort((p, q) => (horizontal ? p.x - q.x : p.y - q.y));
      const ordered = dedupe(along);
      for (let k = 1; k < ordered.length; k += 1) {
        const from = nodeFor(ordered[k - 1]);
        const to = nodeFor(ordered[k]);
        const length = dist(ordered[k - 1], ordered[k]);
        this.edges.push({ a: from, b: to, length });
        this.adjacency[from].push({ to, length });
        this.adjacency[to].push({ to: from, length });
      }
    });
  }

  private project(point: Vec2) {
    let best = { edge: this.edges[0], point: this.nodes[this.edges[0].a], distance: Infinity };
    this.edges.forEach((edge) => {
      const a = this.nodes[edge.a];
      const b = this.nodes[edge.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = clamp01(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1));
      const candidate = v(a.x + dx * t, a.y + dy * t);
      const distance = dist(candidate, point);
      if (distance < best.distance) best = { edge, point: candidate, distance };
    });
    return best;
  }

  route(from: Vec2, to: Vec2): Vec2[] {
    const cacheKey = `${from.x.toFixed(2)},${from.y.toFixed(2)}>${to.x.toFixed(2)},${to.y.toFixed(2)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const start = this.project(from);
    const end = this.project(to);
    let result: Vec2[];
    if (start.edge === end.edge) {
      result = [from, start.point, end.point, to];
    } else {
      const distance = new Array(this.nodes.length).fill(Infinity);
      const previous = new Array<number>(this.nodes.length).fill(-1);
      const done = new Array<boolean>(this.nodes.length).fill(false);
      distance[start.edge.a] = dist(start.point, this.nodes[start.edge.a]);
      distance[start.edge.b] = dist(start.point, this.nodes[start.edge.b]);
      for (;;) {
        let current = -1;
        for (let i = 0; i < this.nodes.length; i += 1) {
          if (!done[i] && distance[i] < Infinity && (current < 0 || distance[i] < distance[current])) current = i;
        }
        if (current < 0) break;
        done[current] = true;
        this.adjacency[current].forEach(({ to: next, length }) => {
          if (distance[current] + length < distance[next]) {
            distance[next] = distance[current] + length;
            previous[next] = current;
          }
        });
      }
      const exitA = distance[end.edge.a] + dist(this.nodes[end.edge.a], end.point);
      const exitB = distance[end.edge.b] + dist(this.nodes[end.edge.b], end.point);
      let node = exitA <= exitB ? end.edge.a : end.edge.b;
      const chain: Vec2[] = [];
      while (node >= 0) {
        chain.unshift(this.nodes[node]);
        node = previous[node];
      }
      result = [from, start.point, ...chain, end.point, to];
    }
    result = dedupe(result);
    this.cache.set(cacheKey, result);
    return result;
  }
}

function intersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = v(b.x - a.x, b.y - a.y);
  const s = v(d.x - c.x, d.y - c.y);
  const denominator = r.x * s.y - r.y * s.x;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denominator;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denominator;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return v(a.x + r.x * t, a.y + r.y * t);
}
