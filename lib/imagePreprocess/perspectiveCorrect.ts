import type { Point } from "./documentDetector";

export type PerspectiveCorrectionResult = {
  canonicalWidth: number;
  canonicalHeight: number;
  corners: [Point, Point, Point, Point];
  note: string;
};

export const DEFAULT_CANONICAL_WIDTH = 1600;
export const DEFAULT_CANONICAL_HEIGHT = 900;
