// Port picker in a normal tab: Chrome won't show it from the side panel. Granting a port here
// gives the whole extension access to it, so the side panel can open it with getPorts().
const msg = document.getElementById('msg');
const pick = document.getElementById('pick');

if (!('serial' in navigator)) {
  pick.disabled = true;
  msg.textContent = 'This browser can\'t open USB serial ports. Use Chrome or Edge on a desktop computer.';
}

pick.addEventListener('click', async () => {
  msg.textContent = '';
  try {
    const port = await navigator.serial.requestPort();
    const info = port.getInfo();
    await chrome.storage.local.set({ heapSerialPort: { info, at: Date.now() } });
    msg.className = 'hint ok';
    msg.textContent = 'Done. Go back to the side panel; it connects by itself. This tab closes in a moment.';
    setTimeout(() => window.close(), 1500);
  } catch (err) {
    msg.textContent = err.name === 'NotFoundError' ? 'No port picked. Press the button and pick the controller.' : err.message;
  }
});
