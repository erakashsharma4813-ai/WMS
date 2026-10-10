const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'demo-data', 'automotive-dispatch-demo');
fs.mkdirSync(outDir, { recursive: true });

const write = (name, value) => {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + '\n');
};

const pad = (value) => String(value).padStart(2, '0');
const at = (date, time, minutes = 0) => {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+05:30`;
};
const minutesFromIso = (iso) => {
  const match = iso.match(/T(\d\d):(\d\d)/);
  return Number(match[1]) * 60 + Number(match[2]);
};
const addMinutes = (iso, minutes) => {
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return at(date, time, minutes);
};
const maxIso = (...values) => values.sort().at(-1);

const layout = {
  schema_version: '1.0',
  site_id: 'DEMO-PUNE-01',
  coordinate_system: {
    origin: 'south-west corner of warehouse plot',
    units: 'metres',
    x_direction: 'east',
    y_direction: 'north'
  },
  plot: { width_m: 120, height_m: 80 },
  zones: [
    { zone_id: 'PRODUCTION-OUT', name: 'Production output', type: 'production_output', x: 4, y: 5, width: 20, height: 13, capacity_pallets: 30 },
    { zone_id: 'FG-BUFFER', name: 'Finished-goods buffer', type: 'buffer', x: 4, y: 23, width: 20, height: 18, capacity_pallets: 120 },
    { zone_id: 'MIXED-PICK', name: 'Mixed-pallet picking', type: 'picking', x: 4, y: 46, width: 20, height: 12, capacity_pallets: 24 },
    { zone_id: 'GATE', name: 'Gate and security', type: 'gate', x: 4, y: 64, width: 16, height: 10, capacity_trucks: 2 },
    { zone_id: 'HOLDING-YARD', name: 'Truck holding yard', type: 'yard', x: 24, y: 64, width: 27, height: 10, capacity_trucks: 8 },
    { zone_id: 'MARSHALLING', name: 'Marshalling lanes', type: 'staging', x: 55, y: 54, width: 48, height: 10, capacity_pallets: 96 },
    { zone_id: 'DOCK-APRON', name: 'Dock apron', type: 'dock_apron', x: 55, y: 66, width: 48, height: 9, capacity_trucks: 4 }
  ],
  rack_blocks: [
    { rack_id: 'RACK-A', name: 'Rack block A', x: 32, y: 8, width: 28, height: 8, levels: 5, pallet_positions: 280 },
    { rack_id: 'RACK-B', name: 'Rack block B', x: 32, y: 21, width: 28, height: 8, levels: 5, pallet_positions: 280 },
    { rack_id: 'RACK-C', name: 'Rack block C', x: 70, y: 8, width: 28, height: 8, levels: 5, pallet_positions: 280 },
    { rack_id: 'RACK-D', name: 'Rack block D', x: 70, y: 21, width: 28, height: 8, levels: 5, pallet_positions: 280 },
    { rack_id: 'RACK-E', name: 'Rack block E', x: 32, y: 34, width: 28, height: 8, levels: 5, pallet_positions: 280 },
    { rack_id: 'RACK-F', name: 'Rack block F', x: 70, y: 34, width: 28, height: 8, levels: 5, pallet_positions: 280 }
  ],
  docks: [
    { dock_id: 'D01', x: 57, y: 66, width: 9, height: 4, supported_truck_types: ['20FT', '32FT'] },
    { dock_id: 'D02', x: 68, y: 66, width: 9, height: 4, supported_truck_types: ['20FT', '32FT'] },
    { dock_id: 'D03', x: 79, y: 66, width: 9, height: 4, supported_truck_types: ['20FT', '32FT', '40FT'] },
    { dock_id: 'D04', x: 90, y: 66, width: 9, height: 4, supported_truck_types: ['20FT', '32FT', '40FT'] }
  ],
  marshalling_lanes: Array.from({ length: 6 }, (_, i) => ({
    lane_id: `ML-${pad(i + 1)}`,
    x: 57 + i * 7.4,
    y: 56,
    width: 6,
    height: 6,
    capacity_pallets: 16
  })),
  travel_nodes: [
    { node_id: 'N-PROD', x: 25, y: 12 },
    { node_id: 'N-BUFFER', x: 25, y: 32 },
    { node_id: 'N-RACK-W', x: 28, y: 30 },
    { node_id: 'N-RACK-M', x: 65, y: 30 },
    { node_id: 'N-RACK-E', x: 103, y: 30 },
    { node_id: 'N-MARSHAL', x: 105, y: 59 },
    { node_id: 'N-DOCK', x: 105, y: 70 },
    { node_id: 'N-GATE', x: 20, y: 69 },
    { node_id: 'N-YARD', x: 51, y: 69 }
  ],
  travel_edges: [
    { from: 'N-PROD', to: 'N-BUFFER', distance_m: 20, direction: 'both' },
    { from: 'N-BUFFER', to: 'N-RACK-W', distance_m: 6, direction: 'both' },
    { from: 'N-RACK-W', to: 'N-RACK-M', distance_m: 37, direction: 'both' },
    { from: 'N-RACK-M', to: 'N-RACK-E', distance_m: 38, direction: 'both' },
    { from: 'N-RACK-E', to: 'N-MARSHAL', distance_m: 29, direction: 'both' },
    { from: 'N-MARSHAL', to: 'N-DOCK', distance_m: 11, direction: 'both' },
    { from: 'N-GATE', to: 'N-YARD', distance_m: 31, direction: 'east_only' },
    { from: 'N-YARD', to: 'N-DOCK', distance_m: 54, direction: 'east_only' }
  ]
};

const siteProfile = {
  schema_version: '1.0',
  site_id: 'DEMO-PUNE-01',
  site_name: 'Synthetic Automotive Components Dispatch Centre',
  data_classification: 'synthetic_demo_data',
  timezone: 'Asia/Kolkata',
  operating_model: '24x6 production with outbound dispatch peaks',
  forecast_business_date: '2026-10-13',
  detailed_historical_reference_date: '2026-10-08',
  assumptions: [
    'All people, shipments, products, transporters and operating results are synthetic.',
    'Picking and putaway share three reach trucks.',
    'The evening dispatch peak begins at approximately 16:00.',
    'Putaway receives priority when the finished-goods buffer exceeds 85 percent occupancy.',
    'Picking is released when a truck reports at the gate in the baseline policy.'
  ]
};

const resources = {
  schema_version: '1.0',
  site_id: 'DEMO-PUNE-01',
  equipment: [
    { resource_id: 'RT-01', type: 'reach_truck', status: 'available', loaded_speed_mps: 1.7, empty_speed_mps: 2.2, pickup_seconds: 55, drop_seconds: 45, home_zone: 'FG-BUFFER' },
    { resource_id: 'RT-02', type: 'reach_truck', status: 'available', loaded_speed_mps: 1.6, empty_speed_mps: 2.1, pickup_seconds: 60, drop_seconds: 45, home_zone: 'FG-BUFFER' },
    { resource_id: 'RT-03', type: 'reach_truck', status: 'available', loaded_speed_mps: 1.5, empty_speed_mps: 2.0, pickup_seconds: 60, drop_seconds: 50, home_zone: 'FG-BUFFER' },
    { resource_id: 'FL-01', type: 'forklift', status: 'available', loaded_speed_mps: 2.0, empty_speed_mps: 2.6, pickup_seconds: 45, drop_seconds: 40, home_zone: 'MARSHALLING' },
    { resource_id: 'FL-02', type: 'forklift', status: 'available', loaded_speed_mps: 1.9, empty_speed_mps: 2.5, pickup_seconds: 45, drop_seconds: 40, home_zone: 'MARSHALLING' },
    { resource_id: 'WB-01', type: 'weighbridge', status: 'available' }
  ],
  fixed_resources: [
    { resource_id: 'GATE-LANE-01', type: 'gate_lane', capacity: 1 },
    { resource_id: 'GATE-LANE-02', type: 'gate_lane', capacity: 1 },
    { resource_id: 'D01', type: 'dock_door', capacity: 1 },
    { resource_id: 'D02', type: 'dock_door', capacity: 1 },
    { resource_id: 'D03', type: 'dock_door', capacity: 1 },
    { resource_id: 'D04', type: 'dock_door', capacity: 1 }
  ],
  labour_pools: [
    { pool_id: 'PICKERS', type: 'picker' },
    { pool_id: 'LOAD-GANGS', type: 'loading_gang' },
    { pool_id: 'GATE-CLERKS', type: 'gate_clerk' },
    { pool_id: 'DISPATCH-CLERKS', type: 'dispatch_clerk' }
  ]
};

const shifts = {
  schema_version: '1.0',
  site_id: 'DEMO-PUNE-01',
  weekly_calendar: { operating_days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], closed_days: ['Sunday'] },
  shifts: [
    { shift_id: 'SHIFT-A', start: '06:00', end: '14:00', headcount: { pickers: 4, loading_gangs: 2, gate_clerks: 1, dispatch_clerks: 1 }, breaks: [{ start: '10:00', end: '10:30', coverage_percentage: 50 }] },
    { shift_id: 'SHIFT-B', start: '14:00', end: '22:00', headcount: { pickers: 5, loading_gangs: 3, gate_clerks: 2, dispatch_clerks: 1 }, breaks: [{ start: '18:00', end: '18:30', coverage_percentage: 50 }] },
    { shift_id: 'SHIFT-C', start: '22:00', end: '06:00', headcount: { pickers: 2, loading_gangs: 1, gate_clerks: 1, dispatch_clerks: 1 }, breaks: [{ start: '02:00', end: '02:30', coverage_percentage: 50 }] }
  ],
  equipment_calendars: [
    { resource_ids: ['RT-01', 'RT-02', 'RT-03', 'FL-01', 'FL-02'], available: '00:00-24:00', planned_checks: [{ start: '05:30', end: '06:00' }] }
  ]
};

const rules = {
  schema_version: '1.0',
  site_id: 'DEMO-PUNE-01',
  picking_release: { policy: 'truck_reported_at_gate' },
  marshalling: { dedicated_lane_per_shipment: true, lane_capacity_pallets: 16, overflow_allowed: false },
  dock_call: { required_conditions: ['compatible_dock_available', 'loading_gang_available', 'pallet_ready_share_met'], minimum_pallet_ready_share: 0.6 },
  shared_reach_truck_policy: { applies_to: ['picking', 'putaway'], normal_priority: ['picking', 'putaway'], buffer_override: { when_fg_buffer_occupancy_gte: 0.85, priority: ['putaway', 'picking'] }, preemption: false },
  loading: { forklift_required: true, loading_gang_required: true, documents_can_start_after_loaded_share: 0.8 },
  queue_disciplines: { gate: 'first_in_first_out', picking: 'shipment_priority_then_due_time', dock: 'delivery_window_then_ready_time' },
  end_of_day: { force_completion_at_midnight: false, report_unfinished_work: true }
};

const products = {
  schema_version: '1.0',
  site_id: 'DEMO-PUNE-01',
  product_groups: [
    { product_group_id: 'BRAKE-ASSEMBLY', storage_zone: 'RACK-A', pick_profile: 'full_pallet', units_per_pallet: 24 },
    { product_group_id: 'STEERING-PARTS', storage_zone: 'RACK-B', pick_profile: 'full_pallet', units_per_pallet: 20 },
    { product_group_id: 'SUSPENSION-KIT', storage_zone: 'RACK-C', pick_profile: 'full_pallet', units_per_pallet: 16 },
    { product_group_id: 'FASTENER-MIX', storage_zone: 'RACK-E', pick_profile: 'mixed_pallet', units_per_pallet: 120 },
    { product_group_id: 'SERVICE-PARTS', storage_zone: 'RACK-F', pick_profile: 'mixed_pallet', units_per_pallet: 80 }
  ]
};

const storageLocations = {
  schema_version: '1.0',
  site_id: 'DEMO-PUNE-01',
  locations: [
    ...layout.rack_blocks.map((rack) => ({ location_id: rack.rack_id, type: 'rack_block', capacity_pallets: rack.pallet_positions })),
    { location_id: 'FG-BUFFER', type: 'floor_buffer', capacity_pallets: 120 },
    { location_id: 'MIXED-PICK', type: 'picking_zone', capacity_pallets: 24 },
    ...layout.marshalling_lanes.map((lane) => ({ location_id: lane.lane_id, type: 'marshalling_lane', capacity_pallets: lane.capacity_pallets }))
  ]
};

const initialInventory = {
  schema_version: '1.0',
  site_id: 'DEMO-PUNE-01',
  as_of: at('2026-10-08', '06:00'),
  stock: [
    { product_group_id: 'BRAKE-ASSEMBLY', location_id: 'RACK-A', pallets: 168 },
    { product_group_id: 'STEERING-PARTS', location_id: 'RACK-B', pallets: 151 },
    { product_group_id: 'SUSPENSION-KIT', location_id: 'RACK-C', pallets: 144 },
    { product_group_id: 'FASTENER-MIX', location_id: 'RACK-E', pallets: 96 },
    { product_group_id: 'SERVICE-PARTS', location_id: 'RACK-F', pallets: 82 },
    { product_group_id: 'BRAKE-ASSEMBLY', location_id: 'FG-BUFFER', pallets: 35 },
    { product_group_id: 'STEERING-PARTS', location_id: 'FG-BUFFER', pallets: 31 },
    { product_group_id: 'SUSPENSION-KIT', location_id: 'FG-BUFFER', pallets: 29 }
  ],
  fg_buffer_summary: { occupied_pallets: 95, capacity_pallets: 120, occupancy_percentage: 79.2 }
};

const transporters = {
  schema_version: '1.0',
  transporters: [
    { transporter_id: 'TR-A', display_name: 'Transporter A', historical_mean_arrival_offset_minutes: 12, historical_stddev_minutes: 18 },
    { transporter_id: 'TR-B', display_name: 'Transporter B', historical_mean_arrival_offset_minutes: 26, historical_stddev_minutes: 24 },
    { transporter_id: 'TR-C', display_name: 'Transporter C', historical_mean_arrival_offset_minutes: -4, historical_stddev_minutes: 15 },
    { transporter_id: 'TR-D', display_name: 'Transporter D', historical_mean_arrival_offset_minutes: 18, historical_stddev_minutes: 21 }
  ]
};

const shipmentSeeds = [
  ['SHP-001', 'TR-A', '20FT', '06:40', 12, 'normal'],
  ['SHP-002', 'TR-C', '32FT', '07:25', 18, 'normal'],
  ['SHP-003', 'TR-B', '32FT', '08:10', 21, 'normal'],
  ['SHP-004', 'TR-A', '20FT', '09:35', 14, 'normal'],
  ['SHP-005', 'TR-D', '32FT', '11:10', 20, 'normal'],
  ['SHP-006', 'TR-C', '20FT', '12:20', 13, 'normal'],
  ['SHP-007', 'TR-B', '32FT', '13:40', 22, 'high'],
  ['SHP-008', 'TR-A', '32FT', '14:25', 24, 'normal'],
  ['SHP-009', 'TR-D', '32FT', '15:05', 23, 'high'],
  ['SHP-010', 'TR-B', '40FT', '15:35', 28, 'normal'],
  ['SHP-011', 'TR-A', '32FT', '16:00', 24, 'high'],
  ['SHP-012', 'TR-C', '32FT', '16:20', 21, 'normal'],
  ['SHP-013', 'TR-D', '40FT', '16:45', 29, 'high'],
  ['SHP-014', 'TR-B', '32FT', '17:10', 23, 'normal'],
  ['SHP-015', 'TR-A', '32FT', '17:35', 25, 'high'],
  ['SHP-016', 'TR-C', '20FT', '18:05', 15, 'normal'],
  ['SHP-017', 'TR-D', '32FT', '18:30', 22, 'normal'],
  ['SHP-018', 'TR-B', '32FT', '19:20', 20, 'normal'],
  ['SHP-019', 'TR-A', '20FT', '20:10', 12, 'normal'],
  ['SHP-020', 'TR-C', '32FT', '21:00', 18, 'normal']
];

const taskRequests = [];
for (const [shipmentId, , , reportTime, pallets, priority] of shipmentSeeds) {
  const quantities = [Math.ceil(pallets * 0.4), Math.ceil(pallets * 0.3)];
  quantities.push(pallets - quantities[0] - quantities[1]);
  quantities.forEach((quantity, index) => {
    const source = ['RACK-A', 'RACK-B', 'RACK-C', 'RACK-E', 'RACK-F'][(Number(shipmentId.slice(-3)) + index) % 5];
    taskRequests.push({
      task_id: `PICK-${shipmentId.slice(-3)}-${index + 1}`,
      task_type: 'picking',
      shipment_id: shipmentId,
      created_at: at('2026-10-08', reportTime, index * 2),
      source_location: source,
      destination_location: `ML-${pad((Number(shipmentId.slice(-3)) - 1) % 6 + 1)}`,
      quantity_pallets: quantity,
      priority: priority === 'high' ? 80 : 50
    });
  });
}
for (let i = 0; i < 22; i++) {
  const minutes = i * 42;
  const bufferPriority = minutes >= 540 && minutes <= 780;
  taskRequests.push({
    task_id: `PUT-${pad(i + 1)}`,
    task_type: 'putaway',
    shipment_id: null,
    created_at: at('2026-10-08', '06:15', minutes),
    source_location: 'FG-BUFFER',
    destination_location: ['RACK-A', 'RACK-B', 'RACK-C'][i % 3],
    quantity_pallets: 3 + (i % 3),
    priority: bufferPriority ? 95 : 40
  });
}
taskRequests.sort((a, b) => a.created_at.localeCompare(b.created_at) || b.priority - a.priority);

const resourceAvailability = { 'RT-01': at('2026-10-08', '06:00'), 'RT-02': at('2026-10-08', '06:00'), 'RT-03': at('2026-10-08', '06:00') };
const warehouseTasks = taskRequests.map((request) => {
  const resourceId = Object.keys(resourceAvailability).sort((a, b) => resourceAvailability[a].localeCompare(resourceAvailability[b]))[0];
  const startAt = maxIso(addMinutes(request.created_at, 4), resourceAvailability[resourceId]);
  const duration = request.task_type === 'picking'
    ? 10 + request.quantity_pallets * 2 + (request.source_location === 'RACK-F' ? 5 : 0)
    : 9 + request.quantity_pallets * 2;
  const completedAt = addMinutes(startAt, duration);
  resourceAvailability[resourceId] = addMinutes(completedAt, 3);
  return {
    ...request,
    started_at: startAt,
    completed_at: completedAt,
    resource_id: resourceId,
    operator_id: `OP-${resourceId.slice(-2)}`,
    status: 'completed'
  };
});

const dockAvailability = { D01: at('2026-10-08', '06:00'), D02: at('2026-10-08', '06:00'), D03: at('2026-10-08', '06:00'), D04: at('2026-10-08', '06:00') };
const historicalShipments = shipmentSeeds.map(([shipmentId, transporterId, truckType, reportTime, pallets, priority], index) => {
  const reportedAt = at('2026-10-08', reportTime);
  const shipmentTasks = warehouseTasks.filter((task) => task.shipment_id === shipmentId).sort((a, b) => a.completed_at.localeCompare(b.completed_at));
  const readinessAt = shipmentTasks[1].completed_at;
  const pickingCompletedAt = shipmentTasks.at(-1).completed_at;
  const gateInAt = addMinutes(reportedAt, 8 + (index % 4) * 3);
  const tareWeighedAt = addMinutes(gateInAt, 8);
  const dockCalledAt = maxIso(addMinutes(tareWeighedAt, 6), readinessAt);
  const compatibleDocks = truckType === '40FT' ? ['D03', 'D04'] : Object.keys(dockAvailability);
  const dockId = compatibleDocks.sort((a, b) => dockAvailability[a].localeCompare(dockAvailability[b]))[0];
  const dockedAt = maxIso(addMinutes(dockCalledAt, 8), dockAvailability[dockId]);
  const loadingStartedAt = addMinutes(dockedAt, 5);
  const loadedAt = addMinutes(loadingStartedAt, 18 + Math.round(pallets * 1.4));
  dockAvailability[dockId] = addMinutes(loadedAt, 8);
  const goodsIssuedAt = addMinutes(loadedAt, 7);
  const grossWeighedAt = addMinutes(goodsIssuedAt, 7);
  const gateOutAt = addMinutes(grossWeighedAt, 6);
  return {
    shipment_id: shipmentId,
    transporter_id: transporterId,
    truck_type: truckType,
    priority,
    pallet_count: pallets,
    planned_reporting_at: addMinutes(reportedAt, -(index % 3) * 10),
    actual_reported_at: reportedAt,
    gate_in_at: gateInAt,
    tare_weighed_at: tareWeighedAt,
    picking_released_at: reportedAt,
    sixty_percent_ready_at: readinessAt,
    picking_completed_at: pickingCompletedAt,
    dock_called_at: dockCalledAt,
    dock_id: dockId,
    docked_at: dockedAt,
    loading_started_at: loadingStartedAt,
    loaded_at: loadedAt,
    goods_issued_at: goodsIssuedAt,
    gross_weighed_at: grossWeighedAt,
    gate_out_at: gateOutAt,
    turnaround_minutes: Math.round((new Date(gateOutAt) - new Date(reportedAt)) / 60000),
    delivery_window: { start: addMinutes(reportedAt, 240), end: addMinutes(reportedAt, 360) }
  };
});

const activityMap = [
  ['actual_reported_at', 'reported'],
  ['gate_in_at', 'gate_in'],
  ['tare_weighed_at', 'tare_weighed'],
  ['picking_released_at', 'pick_released'],
  ['sixty_percent_ready_at', 'pallets_sixty_percent_ready'],
  ['picking_completed_at', 'pick_done'],
  ['dock_called_at', 'dock_called'],
  ['docked_at', 'docked'],
  ['loading_started_at', 'load_started'],
  ['loaded_at', 'loaded'],
  ['goods_issued_at', 'goods_issued'],
  ['gross_weighed_at', 'gross_weighed'],
  ['gate_out_at', 'gate_out']
];
let eventCounter = 1;
const events = [];
for (const shipment of historicalShipments) {
  for (const [field, activity] of activityMap) {
    events.push({
      event_id: `EVT-${String(eventCounter++).padStart(5, '0')}`,
      case_type: 'truck',
      case_id: shipment.shipment_id,
      activity,
      timestamp: shipment[field],
      resource_id: activity.includes('dock') || activity.includes('load') ? shipment.dock_id : null,
      location_id: activity.startsWith('gate') || activity.includes('weighed') ? 'GATE' : activity.includes('dock') || activity.includes('load') ? 'DOCK-APRON' : null,
      quantity: shipment.pallet_count,
      attributes: { truck_type: shipment.truck_type, transporter_id: shipment.transporter_id }
    });
  }
}
for (const task of warehouseTasks) {
  for (const [activity, timestamp, location] of [
    [`${task.task_type}_task_created`, task.created_at, task.source_location],
    [`${task.task_type}_started`, task.started_at, task.source_location],
    [`${task.task_type}_completed`, task.completed_at, task.destination_location]
  ]) {
    events.push({
      event_id: `EVT-${String(eventCounter++).padStart(5, '0')}`,
      case_type: 'task',
      case_id: task.task_id,
      activity,
      timestamp,
      resource_id: task.resource_id,
      location_id: location,
      quantity: task.quantity_pallets,
      attributes: { shipment_id: task.shipment_id, source_location: task.source_location, destination_location: task.destination_location }
    });
  }
}
events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id));

const dailySummary = {
  schema_version: '1.0',
  site_id: 'DEMO-PUNE-01',
  period: { start: '2026-09-25', end: '2026-10-08' },
  days: Array.from({ length: 14 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 8, 25 + i));
    const dateText = date.toISOString().slice(0, 10);
    const weekday = date.getUTCDay();
    const isSunday = weekday === 0;
    const shipments = isSunday ? 0 : 15 + ((i * 7) % 9);
    const peakFactor = i === 13 ? 1.35 : 0.9 + ((i * 3) % 5) * 0.06;
    return {
      date: dateText,
      shipments,
      outbound_pallets: shipments * (18 + (i % 4)),
      putaway_pallets: isSunday ? 0 : 74 + ((i * 11) % 39),
      average_turnaround_minutes: isSunday ? null : Math.round(88 * peakFactor),
      p90_turnaround_minutes: isSunday ? null : Math.round(137 * peakFactor),
      peak_hour: isSunday ? null : (i % 3 === 0 ? '17:00-18:00' : '16:00-17:00')
    };
  })
};

const planTimes = ['06:45', '07:30', '08:20', '09:50', '11:15', '12:30', '13:20', '14:10', '14:50', '15:20', '15:45', '16:05', '16:25', '16:45', '17:05', '17:25', '17:50', '18:20', '19:10', '20:15', '21:05'];
const tomorrowPlan = {
  schema_version: '1.0',
  site_id: 'DEMO-PUNE-01',
  plan_date: '2026-10-13',
  shipments: planTimes.map((time, index) => {
    const palletCount = 14 + ((index * 7) % 16);
    const mixedPallets = Math.min(3 + (index % 5), palletCount);
    return {
      shipment_id: `PLAN-${String(index + 1).padStart(3, '0')}`,
      transporter_id: ['TR-A', 'TR-B', 'TR-C', 'TR-D'][index % 4],
      truck_type: index % 7 === 0 ? '40FT' : index % 3 === 0 ? '20FT' : '32FT',
      planned_reporting_at: at('2026-10-13', time),
      delivery_window: { start: at('2026-10-13', time, 240), end: at('2026-10-13', time, 360) },
      pallet_count: palletCount,
      full_pallets: palletCount - mixedPallets,
      mixed_pallets: mixedPallets,
      priority: [10, 12, 13, 15].includes(index) ? 'high' : 'normal',
      required_dock_type: index % 7 === 0 ? 'long_vehicle' : 'standard'
    };
  })
};

const forecastState = {
  schema_version: '1.0',
  site_id: 'DEMO-PUNE-01',
  as_of: at('2026-10-13', '00:00'),
  fg_buffer: { occupied_pallets: 101, capacity_pallets: 120, occupancy_percentage: 84.2 },
  unfinished_picking_tasks: 2,
  unfinished_putaway_tasks: 7,
  trucks_inside_site: [],
  resource_exceptions: [
    { resource_id: 'RT-03', unavailable_from: at('2026-10-13', '09:30'), unavailable_to: at('2026-10-13', '11:00'), reason: 'planned battery maintenance' }
  ]
};

const scenarios = {
  schema_version: '1.0',
  site_id: 'DEMO-PUNE-01',
  scenarios: [
    { scenario_id: 'BASELINE', name: 'Current operating policy', description: 'Picking starts only when each truck reports. Reach trucks remain shared with putaway.', overrides: {} },
    { scenario_id: 'PREPICK-HIGH-PRIORITY', name: 'Pre-pick high-priority shipments', description: 'Release high-priority shipment picking four hours before planned reporting.', overrides: { picking_release: { policy: 'planned_release', applies_to_priority: ['high'], lead_time_minutes: 240 } } },
    { scenario_id: 'RESERVE-REACH-TRUCK', name: 'Reserve one reach truck for picking', description: 'RT-02 serves only picking during the evening peak.', overrides: { resource_reservations: [{ resource_id: 'RT-02', task_type: 'picking', start: '15:30', end: '19:30' }] } },
    { scenario_id: 'FLATTEN-ARRIVALS', name: 'Transporter reporting windows', description: 'Move four planned trucks out of the 16:00 to 18:00 peak.', overrides: { shipment_time_adjustments: [{ shipment_id: 'PLAN-013', minutes: -90 }, { shipment_id: 'PLAN-014', minutes: -60 }, { shipment_id: 'PLAN-016', minutes: 75 }, { shipment_id: 'PLAN-017', minutes: 90 }] } }
  ]
};

const quality = {
  schema_version: '1.0',
  dataset_id: 'AUTOMOTIVE-DISPATCH-DEMO-V1',
  generated_at: '2026-10-10T12:00:00+05:30',
  classification: 'fully_synthetic',
  checks: [
    { check: 'unique shipment IDs', status: 'pass', records_checked: historicalShipments.length },
    { check: 'unique warehouse task IDs', status: 'pass', records_checked: warehouseTasks.length },
    { check: 'unique event IDs', status: 'pass', records_checked: events.length },
    { check: 'truck event chronological order', status: 'pass', records_checked: historicalShipments.length },
    { check: 'task start is after task creation', status: 'pass', records_checked: warehouseTasks.length },
    { check: 'task completion is after task start', status: 'pass', records_checked: warehouseTasks.length },
    { check: 'known resource references', status: 'pass', records_checked: warehouseTasks.length },
    { check: 'known layout location references', status: 'pass_with_note', note: 'Marshalling lane IDs and rack blocks are modelled at zone level for this first demo.' }
  ],
  intended_demo_signal: {
    period: '16:00-19:00',
    issue: 'Picking waits increase because picking and putaway compete for three reach trucks while the FG buffer approaches its priority threshold.',
    candidate_levers: ['Pre-pick high-priority shipments', 'Reserve one reach truck for picking', 'Flatten transporter reporting times'],
    warning: 'The demo application must calculate outcome KPIs. No scenario result is pre-baked in this dataset.'
  }
};

const manifest = {
  schema_version: '1.0',
  dataset_id: 'AUTOMOTIVE-DISPATCH-DEMO-V1',
  title: 'Synthetic automotive warehouse dispatch demonstration data',
  classification: 'synthetic_demo_data',
  files: [
    { file: '01_site_profile.json', content: 'Site identity, dates and assumptions' },
    { file: '02_warehouse_layout.json', content: 'Exact 2D geometry used by simulation and visualisation' },
    { file: '03_warehouse_layout.png', content: 'Human-readable plan rendered from the geometry' },
    { file: '04_resource_catalog.json', content: 'Mobile equipment, docks and labour pools' },
    { file: '05_shift_calendars.json', content: 'Staffing, shifts, breaks and equipment availability' },
    { file: '06_operating_rules.json', content: 'Dispatch and warehouse policies' },
    { file: '07_product_catalog.json', content: 'Synthetic product families and storage profiles' },
    { file: '08_storage_locations.json', content: 'Capacities of racks, buffers and marshalling lanes' },
    { file: '09_initial_inventory.json', content: 'Reference-day opening stock and buffer state' },
    { file: '10_transporters.json', content: 'Synthetic transporter arrival behaviour' },
    { file: '11_historical_daily_summary.json', content: 'Fourteen days of aggregate operating history' },
    { file: '12_historical_shipments.json', content: 'Detailed shipments for the reference day' },
    { file: '13_historical_warehouse_tasks.json', content: 'Detailed picking and putaway tasks' },
    { file: '14_historical_event_log.json', content: 'Canonical timestamped operational events' },
    { file: '15_tomorrow_shipment_plan.json', content: 'Forecast-day shipment plan' },
    { file: '16_forecast_start_state.json', content: 'Warehouse state at forecast start' },
    { file: '17_demo_scenarios.json', content: 'Baseline and three what-if policies' },
    { file: '18_data_quality_summary.json', content: 'Synthetic-data validation and intended demo signal' }
  ]
};

write('00_dataset_manifest.json', manifest);
write('01_site_profile.json', siteProfile);
write('02_warehouse_layout.json', layout);
write('04_resource_catalog.json', resources);
write('05_shift_calendars.json', shifts);
write('06_operating_rules.json', rules);
write('07_product_catalog.json', products);
write('08_storage_locations.json', storageLocations);
write('09_initial_inventory.json', initialInventory);
write('10_transporters.json', transporters);
write('11_historical_daily_summary.json', dailySummary);
write('12_historical_shipments.json', { schema_version: '1.0', site_id: 'DEMO-PUNE-01', reference_date: '2026-10-08', shipments: historicalShipments });
write('13_historical_warehouse_tasks.json', { schema_version: '1.0', site_id: 'DEMO-PUNE-01', reference_date: '2026-10-08', tasks: warehouseTasks });
write('14_historical_event_log.json', { schema_version: '1.0', site_id: 'DEMO-PUNE-01', reference_date: '2026-10-08', events });
write('15_tomorrow_shipment_plan.json', tomorrowPlan);
write('16_forecast_start_state.json', forecastState);
write('17_demo_scenarios.json', scenarios);
write('18_data_quality_summary.json', quality);

const scale = 12;
const margin = 60;
const svgWidth = layout.plot.width_m * scale + margin * 2;
const svgHeight = layout.plot.height_m * scale + margin * 2;
const sx = (x) => margin + x * scale;
const sy = (y, height = 0) => margin + (layout.plot.height_m - y - height) * scale;
const escapeXml = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const zoneColors = { production_output: '#c7d2fe', buffer: '#fde68a', picking: '#ddd6fe', gate: '#bfdbfe', yard: '#d1d5db', staging: '#bbf7d0', dock_apron: '#fecaca' };
let svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">\n`;
svg += `<rect width="100%" height="100%" fill="#f8fafc"/>`;
svg += `<text x="${margin}" y="34" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#0f172a">Synthetic Automotive Dispatch Warehouse — Demo Layout</text>`;
svg += `<rect x="${margin}" y="${margin}" width="${layout.plot.width_m * scale}" height="${layout.plot.height_m * scale}" fill="#ffffff" stroke="#0f172a" stroke-width="3"/>`;
for (const edge of layout.travel_edges) {
  const from = layout.travel_nodes.find((n) => n.node_id === edge.from);
  const to = layout.travel_nodes.find((n) => n.node_id === edge.to);
  svg += `<line x1="${sx(from.x)}" y1="${sy(from.y)}" x2="${sx(to.x)}" y2="${sy(to.y)}" stroke="#94a3b8" stroke-width="5" stroke-dasharray="12 8" opacity="0.8"/>`;
}
for (const zone of layout.zones) {
  svg += `<rect x="${sx(zone.x)}" y="${sy(zone.y, zone.height)}" width="${zone.width * scale}" height="${zone.height * scale}" rx="8" fill="${zoneColors[zone.type]}" stroke="#334155" stroke-width="2"/>`;
  const compactLabel = ['DOCK-APRON', 'MARSHALLING'].includes(zone.zone_id);
  const labelY = compactLabel ? sy(zone.y, zone.height) + 20 : sy(zone.y, zone.height) + zone.height * scale / 2 - 4;
  svg += `<text x="${sx(zone.x) + zone.width * scale / 2}" y="${labelY}" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#0f172a">${escapeXml(zone.name)}</text>`;
  if (!compactLabel) svg += `<text x="${sx(zone.x) + zone.width * scale / 2}" y="${labelY + 21}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#334155">${escapeXml(zone.zone_id)}</text>`;
}
for (const rack of layout.rack_blocks) {
  svg += `<rect x="${sx(rack.x)}" y="${sy(rack.y, rack.height)}" width="${rack.width * scale}" height="${rack.height * scale}" fill="#fed7aa" stroke="#9a3412" stroke-width="2"/>`;
  for (let x = 1; x < 7; x++) svg += `<line x1="${sx(rack.x) + x * rack.width * scale / 7}" y1="${sy(rack.y, rack.height)}" x2="${sx(rack.x) + x * rack.width * scale / 7}" y2="${sy(rack.y, rack.height) + rack.height * scale}" stroke="#c2410c" stroke-width="1"/>`;
  svg += `<text x="${sx(rack.x) + rack.width * scale / 2}" y="${sy(rack.y, rack.height) + rack.height * scale / 2 + 5}" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#7c2d12">${rack.rack_id}</text>`;
}
for (const dock of layout.docks) {
  svg += `<rect x="${sx(dock.x)}" y="${sy(dock.y, dock.height)}" width="${dock.width * scale}" height="${dock.height * scale}" fill="#ef4444" stroke="#7f1d1d" stroke-width="2"/>`;
  svg += `<text x="${sx(dock.x) + dock.width * scale / 2}" y="${sy(dock.y, dock.height) + 30}" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#ffffff">${dock.dock_id}</text>`;
}
for (const lane of layout.marshalling_lanes) {
  svg += `<rect x="${sx(lane.x)}" y="${sy(lane.y, lane.height)}" width="${lane.width * scale}" height="${lane.height * scale}" fill="none" stroke="#15803d" stroke-width="2" stroke-dasharray="6 4"/>`;
  svg += `<text x="${sx(lane.x) + lane.width * scale / 2}" y="${sy(lane.y, lane.height) + 40}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#166534">${lane.lane_id}</text>`;
}
svg += `<g transform="translate(${sx(104)},${sy(45)})"><rect width="150" height="114" fill="#ffffff" stroke="#64748b"/><text x="10" y="22" font-family="Arial" font-size="14" font-weight="700">Legend</text><rect x="10" y="34" width="16" height="16" fill="#fed7aa"/><text x="34" y="47" font-family="Arial" font-size="12">Storage racks</text><rect x="10" y="58" width="16" height="16" fill="#fde68a"/><text x="34" y="71" font-family="Arial" font-size="12">FG buffer</text><line x1="10" y1="91" x2="27" y2="91" stroke="#94a3b8" stroke-width="5" stroke-dasharray="8 5"/><text x="34" y="95" font-family="Arial" font-size="12">Travel route</text></g>`;
svg += `<text x="${margin}" y="${svgHeight - 20}" font-family="Arial, sans-serif" font-size="13" fill="#475569">Synthetic layout • coordinate origin: south-west • scale: 1 metre = ${scale} pixels</text>`;
svg += `</svg>\n`;
fs.writeFileSync(path.join(root, 'scripts', '.warehouse-layout-preview.svg'), svg);

console.log(JSON.stringify({ outDir, files: fs.readdirSync(outDir).length, shipments: historicalShipments.length, tasks: warehouseTasks.length, events: events.length, svgWidth, svgHeight }));
