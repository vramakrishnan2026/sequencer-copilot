// Pickers in a normal tab: Chrome won't show the USB port picker (and may not show the folder
// picker) from the side panel. What's granted here applies to the whole extension.
import { saveFolder } from './log-file.js';

const folderMode = new URLSearchParams(location.search).has('folder');
const msg = document.getElementById('msg');
const pick = document.getElementById('pick');

if (folderMode) {
  document.title = 'Choose a folder for controller logs · 75F Sequencer Copilot';
  document.getElementById('title').textContent = 'Choose a folder for the controller log';
  document.getElementById('intro').textContent = 'Pick the folder on this PC where the Memory check should save the controller\'s log. You only need to do this once; you can change it later.';
  document.getElementById('extra').hidden = true;
  pick.textContent = 'Choose folder';
} else if (!('serial' in navigator)) {
  pick.disabled = true;
  msg.textContent = 'This browser can\'t open USB serial ports. Use Chrome or Edge on a desktop computer.';
}

function done(text) {
  msg.className = 'hint ok';
  msg.textContent = text;
  setTimeout(() => window.close(), 1500);
}

pick.addEventListener('click', async () => {
  msg.textContent = '';
  try {
    if (folderMode) {
      const dir = await window.showDirectoryPicker({ id: 'controller-logs', mode: 'readwrite' });
      await saveFolder(dir);
      await chrome.storage.local.set({ heapLogFolderAt: Date.now() });
      done(`Folder "${dir.name}" chosen. Go back to the side panel. This tab closes in a moment.`);
      return;
    }
    const port = await navigator.serial.requestPort();
    await chrome.storage.local.set({ heapSerialPort: { info: port.getInfo(), at: Date.now() } });
    done('Done. Go back to the side panel; it connects by itself. This tab closes in a moment.');
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'NotFoundError') msg.textContent = folderMode ? 'No folder picked.' : 'No port picked. Press the button and pick the controller.';
    else msg.textContent = err.message;
  }
});
