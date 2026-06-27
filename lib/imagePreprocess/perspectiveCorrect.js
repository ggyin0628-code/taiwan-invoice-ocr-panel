export const DEFAULT_CANONICAL_WIDTH = 1600;
export const DEFAULT_CANONICAL_HEIGHT = 900;

export async function perspectiveCorrect(sharpInstance, detection, options = {}) {
  const width = options.width || DEFAULT_CANONICAL_WIDTH;
  const height = options.height || DEFAULT_CANONICAL_HEIGHT;
  const sharp = (await import("sharp")).default;
  const source = await sharpInstance.clone().rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = source.info.channels;
  const [rawTopLeft, rawTopRight, rawBottomRight, rawBottomLeft] = detection.corners;
  const topPad = Math.max(0, Math.min(source.info.height * 0.12, ((rawBottomLeft.y + rawBottomRight.y) / 2 - (rawTopLeft.y + rawTopRight.y) / 2) * 0.08));
  const topLeft = { ...rawTopLeft, y: Math.max(0, rawTopLeft.y - topPad) };
  const topRight = { ...rawTopRight, y: Math.max(0, rawTopRight.y - topPad) };
  const bottomRight = rawBottomRight;
  const bottomLeft = rawBottomLeft;
  const output = Buffer.alloc(width * height * channels, 255);

  function pointAt(u, v) {
    const topX = topLeft.x + (topRight.x - topLeft.x) * u;
    const topY = topLeft.y + (topRight.y - topLeft.y) * u;
    const bottomX = bottomLeft.x + (bottomRight.x - bottomLeft.x) * u;
    const bottomY = bottomLeft.y + (bottomRight.y - bottomLeft.y) * u;
    return {
      x: topX + (bottomX - topX) * v,
      y: topY + (bottomY - topY) * v
    };
  }

  for (let y = 0; y < height; y += 1) {
    const v = height === 1 ? 0 : y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = width === 1 ? 0 : x / (width - 1);
      const point = pointAt(u, v);
      const sx = Math.max(0, Math.min(source.info.width - 1, Math.round(point.x)));
      const sy = Math.max(0, Math.min(source.info.height - 1, Math.round(point.y)));
      const sourceIndex = (sy * source.info.width + sx) * channels;
      const targetIndex = (y * width + x) * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        output[targetIndex + channel] = source.data[sourceIndex + channel];
      }
    }
  }

  const buffer = await sharp(output, {
    raw: { width, height, channels }
  }).removeAlpha().jpeg({ quality: 95 }).toBuffer();

  return {
    buffer,
    canonicalWidth: width,
    canonicalHeight: height,
    corners: detection.corners,
    note: "將偵測到的四角映射到固定標準尺寸；正式欄位只使用 OCR bbox 與關鍵字錨點抽取。"
  };
}
