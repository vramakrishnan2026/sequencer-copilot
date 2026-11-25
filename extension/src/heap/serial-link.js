/**
 * Opens the controller's USB serial port with Chrome's Web Serial API and hands over the text.
 * Only works while the side panel is open. Reopens the same port by itself if the controller
 * resets or the cable is unplugged and plugged back in.
 */
export function createSerialLink({ onText, onStatus }) {
  let port = null;
  let info = null;   // usbVendorId / usbProductId of the chosen port, to find it again
  let baud = 115200;
  let reader = null;
  let wanted = false; // the person wants to stay connected
  let retry = null;

  const supported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

  async function open(p) {
    await p.open({ baudRate: baud, bufferSize: 16384 });
    port = p;
    onStatus({ state: 'connected', baud });
    pump();
  }

  async function pump() {
    const dec = new TextDecoder();
    while (port?.readable && wanted) {
      reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) onText(dec.decode(value, { stream: true }));
        }
      } catch (err) {
        // Framing or buffer errors keep the port usable; a lost device doesn't.
        if (!port?.readable) break;
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
        reader = null;
      }
    }
    if (wanted) lost();
  }

  async function lost() {
    try { await port?.close(); } catch { /* gone already */ }
    port = null;
    if (!wanted) return;
    onStatus({ state: 'waiting', baud });
    clearTimeout(retry);
    retry = setTimeout(reopen, 300); // a controller on native USB comes back within a second or two of a restart
  }

  async function reopen() {
    if (!wanted || port) return;
    const ports = await navigator.serial.getPorts();
    const same = ports.find((p) => {
      const i = p.getInfo();
      return info && i.usbVendorId === info.usbVendorId && i.usbProductId === info.usbProductId;
    });
    if (!same) { retry = setTimeout(reopen, 500); return; }
    try { await open(same); } catch { retry = setTimeout(reopen, 500); }
  }

  if (supported()) {
    navigator.serial.addEventListener('connect', () => { if (wanted && !port) reopen(); });
    navigator.serial.addEventListener('disconnect', (e) => { if (e.target === port) lost(); });
  }

  return {
    supported,
    get connected() { return !!port; },
    get baud() { return baud; },
    /**
     * Opens a port the extension may use (granted in the connect tab). Prefers the one picked
     * last. Returns false when no port has been granted yet.
     */
    async connect(rate, preferred = null) {
      if (!supported()) throw new Error('This browser can\'t open USB serial ports. Use Chrome or Edge on a desktop computer.');
      baud = Number(rate) || 115200;
      const ports = await navigator.serial.getPorts();
      if (!ports.length) return false;
      const same = (p, want) => want && p.getInfo().usbVendorId === want.usbVendorId && p.getInfo().usbProductId === want.usbProductId;
      const p = ports.find((x) => same(x, preferred)) || ports[ports.length - 1];
      info = p.getInfo();
      wanted = true;
      try {
        await open(p);
      } catch (err) {
        wanted = false;
        throw new Error(/already open|Failed to open/i.test(err.message)
          ? 'That port is in use. Close Tera Term (or any other program reading the controller), then try again.'
          : err.message);
      }
      return true;
    },
    async disconnect() {
      wanted = false;
      clearTimeout(retry);
      try { await reader?.cancel(); } catch { /* fine */ }
      try { await port?.close(); } catch { /* fine */ }
      port = null;
      onStatus({ state: 'off', baud });
    },
  };
}
