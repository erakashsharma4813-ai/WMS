// Scene palettes. "industrial" is the dark plant-floor look (dark slate yard,
// concrete floor, strong yellow safety lines); "light" is the original look.
import { createContext, useContext } from "react";

export type ScenePalette = {
  outerGround: string;
  plotGround: string;
  asphalt: string;
  roadPaint: string;
  slab: string;
  floor: string;
  annex: string;
  wall: string;
  farWall: string;
  farWallSide: string;
  wallRib: string;
  truss: string;
  column: string;
  ceilingLight: string;
  safetyYellow: string;
  walkway: string;
  zoneOpacity: number;
  sky: string;
  dusk: string;
  night: string;
  hemiGround: string;
  fogNear: number;
  fogFar: number;
};

export const PALETTES: Record<"industrial" | "light", ScenePalette> = {
  industrial: {
    outerGround: "#2b3137",
    plotGround: "#353c43",
    asphalt: "#262b30",
    roadPaint: "#c9ced2",
    slab: "#40474d",
    floor: "#575e64",
    annex: "#5a564d",
    wall: "#46525c",
    farWall: "#3a4651",
    farWallSide: "#33404a",
    wallRib: "#55636e",
    truss: "#2a3640",
    column: "#1f2a32",
    ceilingLight: "#fff6dc",
    safetyYellow: "#f5c518",
    walkway: "#2fae5f",
    zoneOpacity: 0.16,
    sky: "#262d34",
    dusk: "#2e2c33",
    night: "#14191e",
    hemiGround: "#2e3a40",
    fogNear: 170,
    fogFar: 300,
  },
  light: {
    outerGround: "#dfe8e3",
    plotGround: "#cfd8d5",
    asphalt: "#b3bdbc",
    roadPaint: "#f8faf9",
    slab: "#c3ccca",
    floor: "#eef2f1",
    annex: "#d6c8a8",
    wall: "#dbe6e3",
    farWall: "#d8e6e2",
    farWallSide: "#cddfda",
    wallRib: "#bfd2cd",
    truss: "#9fb6b9",
    column: "#7f979b",
    ceilingLight: "#fffdf2",
    safetyYellow: "#f1c232",
    walkway: "#4fb37c",
    zoneOpacity: 1,
    sky: "#eaf2ef",
    dusk: "#efdcc7",
    night: "#2c3b44",
    hemiGround: "#b8cbc5",
    fogNear: 150,
    fogFar: 260,
  },
};

export const PaletteContext = createContext<ScenePalette>(PALETTES.industrial);
export const usePalette = () => useContext(PaletteContext);
