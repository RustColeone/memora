// PDF.js's legacy build still calls Array.at (Chrome 92+). Include this in both
// the main module and its worker; workers have their own built-in objects.
(function () {
  'use strict';
  if (typeof Array.prototype.at === 'function') return;
  Object.defineProperty(Array.prototype, 'at', {
    configurable: true,
    writable: true,
    value: function (index) {
      var length = Math.min(Math.max(Math.floor(Number(this.length) || 0), 0), 9007199254740991);
      var offset = Number(index) || 0;
      offset = offset < 0 ? Math.ceil(offset) : Math.floor(offset);
      if (offset < 0) offset += length;
      return offset < 0 || offset >= length ? undefined : this[offset];
    }
  });
})();
