// Worker encoding avoids WebView's heavily deferred main-thread canvas encoder.
self.onmessage = async event => {
  const { bitmap, type, quality } = event.data;
  let canvas;
  try {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type, quality });
    self.postMessage({ blob });
  } catch (error) {
    bitmap.close();
    self.postMessage({ error: error.message || 'Image encoding failed.' });
  } finally { if (canvas) canvas.width = canvas.height = 1; }
};
