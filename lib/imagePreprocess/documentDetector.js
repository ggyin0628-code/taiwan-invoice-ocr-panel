export function orderCorners(points) {
  const sorted = [...points].sort((a, b) => a.y - b.y);
  const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = sorted.slice(2, 4).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bottom[1], bottom[0]];
}

export async function detectDocumentRectangle(sharpInstance) {
  const { data, info } = await sharpInstance.clone().rotate().raw().toBuffer({ resolveWithObject: true });
  const edgePoints = [];
  const bluePoints = [];
  const lightPoints = [];
  const rowBlue = new Array(info.height).fill(0);
  const sampleStep = Math.max(1, Math.floor(Math.min(info.width, info.height) / 900));

  for (let y = 0; y < info.height; y += sampleStep) {
    for (let x = 0; x < info.width; x += sampleStep) {
      const index = (y * info.width + x) * info.channels;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      const isBlue = b > 78 && b > r * 1.08 && b > g * 1.02 && r < 205;
      const isPaper = luminance > 150 && Math.abs(r - g) < 42 && Math.abs(g - b) < 58;
      const isDocumentEdge = luminance > 135 && Math.abs(r - g) < 60 && Math.abs(g - b) < 70;
      if (isDocumentEdge) edgePoints.push({ x, y });
      if (isBlue) {
        bluePoints.push({ x, y });
        rowBlue[y] += 1;
      }
      if (isPaper) lightPoints.push({ x, y });
    }
  }

  const rowThreshold = Math.max(4, Math.round((info.width / sampleStep) * 0.01));
  const bands = [];
  let start = -1;
  let score = 0;
  for (let y = 0; y < info.height; y += 1) {
    if (rowBlue[y] >= rowThreshold) {
      if (start < 0) {
        start = y;
        score = 0;
      }
      score += rowBlue[y];
    } else if (start >= 0) {
      if (y - start > info.height * 0.08) bands.push({ top: start, bottom: y - 1, score });
      start = -1;
      score = 0;
    }
  }
  if (start >= 0) bands.push({ top: start, bottom: info.height - 1, score });
  const upperBands = bands.filter((band) => band.top < info.height * 0.72);
  const bestBand = (upperBands.length ? upperBands : bands).sort((a, b) => b.score - a.score)[0];
  const focusedBluePoints = bestBand
    ? bluePoints.filter((point) => point.y >= bestBand.top && point.y <= bestBand.bottom)
    : bluePoints;
  const points = edgePoints.length > 300 ? edgePoints : (focusedBluePoints.length > 80 ? focusedBluePoints : lightPoints);
  if (!points.length) {
    return {
      corners: [
        { x: 0, y: 0 },
        { x: info.width, y: 0 },
        { x: info.width, y: info.height },
        { x: 0, y: info.height }
      ],
      boundingBox: { left: 0, top: 0, width: info.width, height: info.height },
      confidence: 0,
      method: "full-image"
    };
  }

  const xs = points.map((point) => point.x).sort((a, b) => a - b);
  const ys = points.map((point) => point.y).sort((a, b) => a - b);
  const quantile = (values, q) => values[Math.max(0, Math.min(values.length - 1, Math.floor(values.length * q)))];
  const left = Math.max(0, quantile(xs, 0.01) - Math.round(info.width * 0.015));
  const right = Math.min(info.width - 1, quantile(xs, 0.99) + Math.round(info.width * 0.015));
  const top = Math.max(0, quantile(ys, 0.01) - Math.round(info.height * 0.055));
  const bottom = Math.min(info.height - 1, quantile(ys, 0.99) + Math.round(info.height * 0.015));
  const width = Math.max(1, right - left + 1);
  const height = Math.max(1, bottom - top + 1);

  return {
    corners: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom }
    ],
    boundingBox: { left, top, width, height },
    confidence: Math.min(1, points.length / ((info.width * info.height) / (sampleStep * sampleStep) * 0.08)),
    method: edgePoints.length > 300 ? "opencv-style-largest-contour" : (bluePoints.length > 80 ? "blue-ink-bounds" : "luminance-bounds")
  };
}
