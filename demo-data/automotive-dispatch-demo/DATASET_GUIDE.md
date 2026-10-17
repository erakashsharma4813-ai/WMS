# Automotive Dispatch Demo Dataset Guide

This folder contains a fully synthetic warehouse dataset for demonstrating a warehouse and dispatch digital twin. Each file contains one type of information so that layout, resources, operating rules, history, forecasts, and scenarios can be changed independently.

All people, shipments, products, transporters, timestamps, and operating results in this dataset are synthetic.

## How the files connect

For example, shipment `SHP-011`:

```text
SHP-011 shipment
    |
    +-- has three picking tasks
    |       +-- performed by RT-01 / RT-02 / RT-03
    |
    +-- picks pallets from warehouse racks
    +-- stages pallets in a marshalling lane
    +-- receives a dock assignment
    +-- is loaded and leaves the warehouse
    +-- produces timestamped events for the 3D replay
```

## 00 - Dataset manifest

File: `00_dataset_manifest.json`

This is the index of the dataset. It identifies the dataset and lists every file that belongs to it.

Example:

```json
{
  "dataset_id": "AUTOMOTIVE-DISPATCH-DEMO-V1",
  "classification": "synthetic_demo_data",
  "files": [
    {
      "file": "04_resource_catalog.json",
      "content": "Mobile equipment, docks and labour pools"
    }
  ]
}
```

The application can load this file first and then locate all required inputs.

## 01 - Site profile

File: `01_site_profile.json`

This identifies the warehouse and records the main assumptions and business dates.

Example:

```json
{
  "site_id": "DEMO-PUNE-01",
  "site_name": "Synthetic Automotive Components Dispatch Centre",
  "timezone": "Asia/Kolkata",
  "forecast_business_date": "2026-10-13",
  "detailed_historical_reference_date": "2026-10-08"
}
```

It answers:

- Which site is being simulated?
- Which timezone should be used?
- Which date is used for the historical replay?
- Which date is being forecast?
- Which important assumptions were made?

## 02 - Warehouse layout

File: `02_warehouse_layout.json`

This is the machine-readable warehouse plan. It contains exact coordinates in metres.

Example zone:

```json
{
  "zone_id": "FG-BUFFER",
  "name": "Finished-goods buffer",
  "type": "buffer",
  "x": 4,
  "y": 23,
  "width": 20,
  "height": 18,
  "capacity_pallets": 120
}
```

This means that the buffer begins 4 metres east and 23 metres north of the site origin. It is 20 metres wide, 18 metres long, and can hold 120 pallets.

Example rack:

```json
{
  "rack_id": "RACK-A",
  "x": 32,
  "y": 8,
  "width": 28,
  "height": 8,
  "levels": 5,
  "pallet_positions": 280
}
```

The file defines:

- Gate and holding yard
- Six rack blocks
- Four dock doors
- Six marshalling lanes
- Production output
- Mixed-pallet picking
- Equipment and vehicle travel routes

The simulator uses these coordinates to calculate travel distance. The 3D viewer uses them to position warehouse objects.

## 03 - Warehouse layout image

File: `03_warehouse_layout.png`

This is the human-readable representation of `02_warehouse_layout.json`.

It shows the gate, holding yard, docks, marshalling lanes, rack blocks, finished-goods buffer, production output, mixed-pallet area, and travel routes.

The PNG is for review and presentation. The simulator should use the layout JSON and should not try to extract information from the image.

## 04 - Resource catalog

File: `04_resource_catalog.json`

This lists mobile equipment, fixed resources, and labour pools.

Example reach truck:

```json
{
  "resource_id": "RT-01",
  "type": "reach_truck",
  "status": "available",
  "loaded_speed_mps": 1.7,
  "empty_speed_mps": 2.2,
  "pickup_seconds": 55,
  "drop_seconds": 45,
  "home_zone": "FG-BUFFER"
}
```

The simulator can calculate task time using:

```text
Task time
= empty travel to source
+ pallet pickup
+ loaded travel to destination
+ pallet drop
```

The catalog currently contains:

- Three reach trucks: `RT-01`, `RT-02`, and `RT-03`
- Two forklifts: `FL-01` and `FL-02`
- One weighbridge
- Two gate lanes
- Four dock doors
- Picker, loading-gang, gate-clerk, and dispatch-clerk labour pools

Example fixed resource:

```json
{
  "resource_id": "D01",
  "type": "dock_door",
  "capacity": 1
}
```

Only one truck can occupy dock `D01` at a time.

## 05 - Shift calendars

File: `05_shift_calendars.json`

This defines when people and machines are available.

Example:

```json
{
  "shift_id": "SHIFT-B",
  "start": "14:00",
  "end": "22:00",
  "headcount": {
    "pickers": 5,
    "loading_gangs": 3,
    "gate_clerks": 2,
    "dispatch_clerks": 1
  },
  "breaks": [
    {
      "start": "18:00",
      "end": "18:30",
      "coverage_percentage": 50
    }
  ]
}
```

At 18:00, only 50% of the shift remains available during the break. This matters because the break overlaps the evening dispatch peak.

The file also contains equipment availability and planned checks.

## 06 - Operating rules

File: `06_operating_rules.json`

This defines how the warehouse operates.

Picking-release example:

```json
{
  "picking_release": {
    "policy": "truck_reported_at_gate"
  }
}
```

Picking does not begin until the truck reports at the gate.

Dock-call example:

```json
{
  "dock_call": {
    "required_conditions": [
      "compatible_dock_available",
      "loading_gang_available",
      "pallet_ready_share_met"
    ],
    "minimum_pallet_ready_share": 0.6
  }
}
```

A truck can be called only when a compatible dock, loading gang, and at least 60% of its pallets are ready.

Putaway-priority example:

```json
{
  "buffer_override": {
    "when_fg_buffer_occupancy_gte": 0.85,
    "priority": ["putaway", "picking"]
  }
}
```

When the finished-goods buffer reaches 85% occupancy, putaway receives priority over picking. This is the main cause of the synthetic evening bottleneck.

## 07 - Product catalog

File: `07_product_catalog.json`

This describes the product families stored in the warehouse.

Example:

```json
{
  "product_group_id": "BRAKE-ASSEMBLY",
  "storage_zone": "RACK-A",
  "pick_profile": "full_pallet",
  "units_per_pallet": 24
}
```

It tells the model where the product is stored, whether it is normally picked as a full or mixed pallet, and how many units are held on a pallet.

The synthetic product families are:

- Brake assemblies
- Steering parts
- Suspension kits
- Mixed fasteners
- Service parts

## 08 - Storage locations

File: `08_storage_locations.json`

This defines the operational capacity and purpose of each storage or staging location.

Example:

```json
{
  "location_id": "ML-01",
  "type": "marshalling_lane",
  "capacity_pallets": 16
}
```

Another example:

```json
{
  "location_id": "FG-BUFFER",
  "type": "floor_buffer",
  "capacity_pallets": 120
}
```

The difference between this file and the warehouse layout is:

- The layout defines physical position and dimensions.
- Storage locations define operational capacity and usage.

## 09 - Initial inventory

File: `09_initial_inventory.json`

This is the warehouse inventory at the start of the historical reference day, October 8, 2026.

Example:

```json
{
  "product_group_id": "BRAKE-ASSEMBLY",
  "location_id": "RACK-A",
  "pallets": 168
}
```

The file also defines the opening finished-goods buffer:

```json
{
  "occupied_pallets": 95,
  "capacity_pallets": 120,
  "occupancy_percentage": 79.2
}
```

The warehouse should not start empty. At 79.2%, only seven additional pallets are needed before the 85% putaway-priority threshold is reached.

## 10 - Transporters

File: `10_transporters.json`

This describes synthetic transporter arrival behaviour.

Example:

```json
{
  "transporter_id": "TR-B",
  "display_name": "Transporter B",
  "historical_mean_arrival_offset_minutes": 26,
  "historical_stddev_minutes": 24
}
```

This means that trucks from Transporter B report an average of 26 minutes later than planned, with substantial variation.

The forecast can use this to calculate:

```text
Simulated arrival
= planned arrival
+ sampled transporter delay
```

## 11 - Historical daily summary

File: `11_historical_daily_summary.json`

This contains aggregated operational results for 14 days.

Example:

```json
{
  "date": "2026-10-08",
  "shipments": 20,
  "outbound_pallets": 420,
  "putaway_pallets": 100,
  "average_turnaround_minutes": 119,
  "p90_turnaround_minutes": 185,
  "peak_hour": "17:00-18:00"
}
```

This dataset is useful for historical trend charts, identifying abnormal days, calibrating daily volume, and comparing the selected day with previous days.

It does not contain individual truck or task details.

## 12 - Historical shipments

File: `12_historical_shipments.json`

This contains one record for each truck or shipment on the detailed historical day.

Example:

```json
{
  "shipment_id": "SHP-011",
  "transporter_id": "TR-A",
  "truck_type": "32FT",
  "priority": "high",
  "pallet_count": 24,
  "actual_reported_at": "2026-10-08T16:00:00+05:30",
  "picking_completed_at": "2026-10-08T17:09:00+05:30",
  "dock_id": "D02",
  "gate_out_at": "2026-10-08T18:13:00+05:30",
  "turnaround_minutes": 133
}
```

It describes the truck journey:

```text
Reported
-> gate entry
-> tare weighing
-> picking released
-> pallets ready
-> dock called
-> docked
-> loaded
-> goods issued
-> gross weighed
-> gate out
```

This file is primarily used for truck-turnaround analysis.

## 13 - Historical warehouse tasks

File: `13_historical_warehouse_tasks.json`

This contains detailed picking and putaway work.

Picking example:

```json
{
  "task_id": "PICK-011-1",
  "task_type": "picking",
  "shipment_id": "SHP-011",
  "source_location": "RACK-B",
  "destination_location": "ML-05",
  "quantity_pallets": 10,
  "resource_id": "RT-02",
  "status": "completed"
}
```

The timestamps allow the system to calculate:

```text
Waiting time = started_at - created_at
Processing time = completed_at - started_at
```

Putaway example:

```json
{
  "task_id": "PUT-12",
  "task_type": "putaway",
  "shipment_id": null,
  "source_location": "FG-BUFFER",
  "destination_location": "RACK-C",
  "quantity_pallets": 5,
  "resource_id": "RT-01"
}
```

A putaway task has no outbound shipment because it moves production stock into warehouse storage.

This file demonstrates how picking and putaway compete for the same reach trucks.

## 14 - Historical event log

File: `14_historical_event_log.json`

This is the canonical chronological event stream. It contains one row for every important state change.

Example truck event:

```json
{
  "event_id": "EVT-00137",
  "case_type": "truck",
  "case_id": "SHP-011",
  "activity": "dock_called",
  "timestamp": "2026-10-08T16:48:00+05:30",
  "resource_id": "D02",
  "quantity": 24
}
```

Example task event:

```json
{
  "event_id": "EVT-00394",
  "case_type": "task",
  "case_id": "PICK-011-1",
  "activity": "picking_started",
  "timestamp": "2026-10-08T16:18:00+05:30",
  "resource_id": "RT-02",
  "location_id": "RACK-B",
  "quantity": 10
}
```

This file is used for:

- Historical replay
- 3D animation
- Queue reconstruction
- Resource-utilisation calculations
- Activity-duration fitting
- Process analysis

The difference from the shipment and task files is that this file has one record per state change instead of one record per complete object.

## 15 - Tomorrow's shipment plan

File: `15_tomorrow_shipment_plan.json`

This is the workload planned for the forecast day.

Example:

```json
{
  "shipment_id": "PLAN-013",
  "transporter_id": "TR-A",
  "truck_type": "32FT",
  "planned_reporting_at": "2026-10-13T16:25:00+05:30",
  "pallet_count": 18,
  "full_pallets": 13,
  "mixed_pallets": 5,
  "priority": "high",
  "required_dock_type": "standard"
}
```

Unlike a historical shipment, it does not contain actual timestamps for gate-out or loading completion because those events have not happened yet.

The forecast simulation calculates expected outcomes using planned workload, arrival uncertainty, task durations, resources, and operating rules.

## 16 - Forecast start state

File: `16_forecast_start_state.json`

This describes warehouse conditions when the forecast begins.

Example:

```json
{
  "fg_buffer": {
    "occupied_pallets": 101,
    "capacity_pallets": 120,
    "occupancy_percentage": 84.2
  },
  "unfinished_picking_tasks": 2,
  "unfinished_putaway_tasks": 7
}
```

The finished-goods buffer is already close to its 85% priority threshold.

The file also contains resource exceptions:

```json
{
  "resource_id": "RT-03",
  "unavailable_from": "2026-10-13T09:30:00+05:30",
  "unavailable_to": "2026-10-13T11:00:00+05:30",
  "reason": "planned battery maintenance"
}
```

This prevents the forecast from assuming that the warehouse starts empty with every resource available.

## 17 - Demo scenarios

File: `17_demo_scenarios.json`

This defines operating policies that can be compared with the baseline.

### Baseline

```json
{
  "scenario_id": "BASELINE",
  "name": "Current operating policy",
  "overrides": {}
}
```

The baseline uses the normal operating rules without any changes.

### Pre-picking

```json
{
  "scenario_id": "PREPICK-HIGH-PRIORITY",
  "overrides": {
    "picking_release": {
      "policy": "planned_release",
      "applies_to_priority": ["high"],
      "lead_time_minutes": 240
    }
  }
}
```

High-priority shipments are released for picking four hours before their planned reporting time.

### Reserved reach truck

```json
{
  "scenario_id": "RESERVE-REACH-TRUCK",
  "overrides": {
    "resource_reservations": [
      {
        "resource_id": "RT-02",
        "task_type": "picking",
        "start": "15:30",
        "end": "19:30"
      }
    ]
  }
}
```

`RT-02` cannot perform putaway during the evening peak.

### Flattened arrivals

The transporter-window scenario moves selected trucks outside the congested reporting period.

The simulation should run every scenario using the same random seed set and compare the results with the baseline.

## 18 - Data-quality summary

File: `18_data_quality_summary.json`

This records which dataset checks were performed.

Example:

```json
{
  "check": "task completion is after task start",
  "status": "pass",
  "records_checked": 82
}
```

It also records the intended synthetic issue:

```json
{
  "period": "16:00-19:00",
  "issue": "Picking waits increase because picking and putaway compete for three reach trucks while the FG buffer approaches its priority threshold."
}
```

This file is validation evidence and is not a simulation input.

## 19 - Production availability

File: `19_production_availability.json`

This defines when outbound pallets become available from production. Each shipment is assigned a production profile that releases three pallet batches at different times, including a quality-release delay. The simulator therefore distinguishes production waiting from warehouse picking waiting. It also contains planned line exceptions such as tooling changes.

## Important differences between similar files

| Dataset | What it represents |
|---|---|
| Historical shipments | Completed truck journeys |
| Historical warehouse tasks | Completed picking and putaway work |
| Historical event log | Every timestamped state change used for replay |
| Tomorrow's shipment plan | Work expected on the forecast day |
| Forecast start state | Work and inventory already present when forecasting starts |
| Demo scenarios | Alternative operating policies to test |
| Layout, resources, shifts, and rules | The warehouse's physical and operational configuration |

## Intended demonstration story

The dataset is designed to produce an evening bottleneck between 16:00 and 19:00:

1. Several outbound trucks report during the same period.
2. Their picking tasks are released when they report.
3. The finished-goods buffer approaches 85% occupancy.
4. Putaway receives priority to prevent the buffer from becoming full.
5. Picking and putaway compete for three reach trucks.
6. Picking queues increase and pallets are not ready for loading.
7. Trucks wait longer even when some dock capacity is available.

The demo scenarios test whether pre-picking, reserving a reach truck, or flattening transporter arrivals improves the operation.

