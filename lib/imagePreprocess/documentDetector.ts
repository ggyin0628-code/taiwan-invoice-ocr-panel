export type Point = { x: number; y: number };

export type DocumentDetection = {
  corners: [Point, Point, Point, Point];
  boundingBox: { left: number; top: number; width: number; height: number };
  confidence: number;
  method: "blue-ink-bounds" | "luminance-bounds" | "full-image";
};

export function orderCorners(points: Point[]): [Point, Point, Point, Point] {
  const sorted = [...points].sort((a, b) => a.y - b.y);
  const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = sorted.slice(2, 4).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bottom[1], bottom[0]];
}
