'use strict';

function nearPoint(point, size, area, gap = 12) {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const preferredX = point.x + gap + width <= area.x + area.width ? point.x + gap : point.x - width - gap;
  const preferredY = point.y + gap + height <= area.y + area.height ? point.y + gap : point.y - height - gap;
  return {
    x: Math.round(Math.max(area.x, Math.min(preferredX, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(preferredY, area.y + area.height - height))),
    width: Math.round(width), height: Math.round(height),
  };
}

function cropRectangle(rect, displaySize, imageSize) {
  if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))) throw new Error('截图选区无效。');
  if (rect.x < 0 || rect.y < 0 || rect.width < 8 || rect.height < 8 || rect.x + rect.width > displaySize.width + 1 || rect.y + rect.height > displaySize.height + 1) throw new Error('请在屏幕内框选至少 8 × 8 的区域。');
  const x = Math.floor(rect.x * imageSize.width / displaySize.width);
  const y = Math.floor(rect.y * imageSize.height / displaySize.height);
  const right = Math.min(imageSize.width, Math.ceil((rect.x + rect.width) * imageSize.width / displaySize.width));
  const bottom = Math.min(imageSize.height, Math.ceil((rect.y + rect.height) * imageSize.height / displaySize.height));
  return { x, y, width: right - x, height: bottom - y };
}

module.exports = { nearPoint, cropRectangle };
