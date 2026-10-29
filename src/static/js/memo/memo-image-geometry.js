// Geometry adapted from ImageDB/src/image-editor.js. Crops use original-image coordinates.
(function (global) {
"use strict";
function ieResolveGeometry(ops, limit = ops.length) {
  const geometry = { turns: 0, flipH: false, flipV: false, crop: { x: 0, y: 0, w: 1, h: 1 } };
  for (let index = 0; index < Math.min(limit, ops.length); index++) {
    const op = ops[index];
    if (op.type === 'rotate') {
      geometry.turns = (geometry.turns + (Number(op.params.turns) || 0)) & 3;
    } else if (op.type === 'flip') {
      // Buttons refer to the displayed axes. The renderer applies flips before
      // rotation, so an odd quarter turn exchanges horizontal and vertical.
      const vertical = (op.params.axis === 'v') !== !!(geometry.turns & 1);
      if (vertical) geometry.flipV = !geometry.flipV;
      else geometry.flipH = !geometry.flipH;
    } else if (op.type === 'crop') {
      // Intersect in original space: a later crop can only ever narrow the frame.
      const previous = geometry.crop;
      const next = op.params;
      const x = Math.max(previous.x, Number(next.x) || 0);
      const y = Math.max(previous.y, Number(next.y) || 0);
      const right = Math.min(previous.x + previous.w, (Number(next.x) || 0) + (Number(next.w) || 1));
      const bottom = Math.min(previous.y + previous.h, (Number(next.y) || 0) + (Number(next.h) || 1));
      geometry.crop = { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
    }
  }
  return geometry;
}

function ieGeometrySize(geometry, sourceWidth, sourceHeight) {
  const width = Math.max(1, Math.round(geometry.crop.w * sourceWidth));
  const height = Math.max(1, Math.round(geometry.crop.h * sourceHeight));
  return (geometry.turns & 1) ? { width: height, height: width } : { width, height };
}

function ieViewRectToSourceCrop(rect, canvasWidth, canvasHeight, ops) {
  const geometry = ieResolveGeometry(ops);
  // Normalise within the displayed frame first.
  let x = rect.x / canvasWidth;
  let y = rect.y / canvasHeight;
  let w = rect.w / canvasWidth;
  let h = rect.h / canvasHeight;
  // The render applies scale(flip) INSIDE rotate() — i.e. source is flipped first and
  // the result rotated — so the inverse must undo the rotation first, then the flip.
  // Undo rotation: one quarter turn clockwise maps source (u,v) → display (1-v, u),
  // so the inverse of a display rect is (y, 1-x-w, h, w).
  for (let turn = 0; turn < (geometry.turns & 3); turn++) {
    const nx = y, ny = 1 - x - w, nw = h, nh = w;
    x = nx; y = ny; w = nw; h = nh;
  }
  // Undo flips, now that we are back in the (unrotated) source frame.
  if (geometry.flipH) x = 1 - x - w;
  if (geometry.flipV) y = 1 - y - h;
  // Re-express inside the current crop window, in original coordinates.
  return {
    x: geometry.crop.x + x * geometry.crop.w,
    y: geometry.crop.y + y * geometry.crop.h,
    w: w * geometry.crop.w,
    h: h * geometry.crop.h,
  };
}

global.MemoImageGeometry = { resolve: ieResolveGeometry, size: ieGeometrySize, crop: ieViewRectToSourceCrop };
})(window);
