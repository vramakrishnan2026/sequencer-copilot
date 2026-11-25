# Publishing Sequencer Copilot on the Chrome Web Store (unlisted)

Made by Vinay. Unlisted means only people with the link can install it, and everyone who installs it gets
updates automatically.

## One-time setup

1. Go to the Chrome Web Store Developer Dashboard (search "Chrome Web Store developer dashboard") and sign in
   with the Google account that should own the extension.
2. Register as a developer and pay the one-time registration fee.
3. Host the privacy statement (`PRIVACY.md` in this folder) somewhere public and note its link, for example a
   public GitHub Gist, a GitHub Pages page or a Google Sites page.

## First upload

1. In the dashboard, choose **New item** and upload `75f-sequencer-copilot-v0.7.3.zip` as it is.
2. Fill in the tabs as below, then **Submit for review**. Review usually takes from a day to a few days.
3. When it is approved, copy the item's store link and share it with colleagues.

## Store listing tab

- **Description** (paste):

  > Sequencer Copilot helps engineers build and change control logic on the 75F Site Sequencer with an AI
  > assistant such as ChatGPT, Claude or Microsoft 365 Copilot.
  >
  > Export the canvas for your assistant, paste back its plan, review each change in plain words, and apply it
  > with one-step undo. View any sequence, or a proposed change, as a logic map: a flowchart of the steps and
  > decisions, or a signal map of what each output is worked out from. Then test it in the built-in simulator:
  > move virtual inputs and watch relays, analog outputs and model points respond, before the sequence goes to a
  > Connect module.
  >
  > Works only on the 75F Site Sequencer (internal.75f.io and altius.75f.io). Nothing is sent anywhere: the
  > extension talks to your AI assistant only through what you copy and paste.
  >
  > Made by Vinay.

- **Category**: Developer Tools (or Productivity).
- **Language**: English.
- **Store icon**: `store-icon-128.png`.
- **Screenshots** (1280×800): `screenshot-4-side-panel-simulator.png`, `screenshot-1-flowchart.png`, `screenshot-2-change-preview.png`,
  `screenshot-3-signals.png`. A screenshot of the side panel open next to a real sequence makes a good fourth;
  take it at 1280×800 with nothing confidential on the canvas.
- **Small promo tile** (440×280): `promo-tile-440x280.png`.

## Privacy practices tab

- **Single purpose** (paste):

  > Helps engineers create and change control logic on the 75F Site Sequencer with an AI assistant: it exports
  > the canvas, applies pasted plans, draws logic maps and simulates the sequence.

- **Permission justifications** (paste each into its own box):
  - `sidePanel`:
    > The extension's whole interface is a side panel shown next to the 75F Site Sequencer page. The panel is where
    > the user exports the sequence for their AI assistant, pastes the assistant's plan, reviews and applies the
    > change, and runs the simulator.
  - `scripting`:
    > The Site Sequencer draws its Blockly canvas inside a frame of the page. The extension uses
    > chrome.scripting.executeScript only to find which frame holds the canvas, so its requests go to the right
    > frame. It runs only on 75f.io pages, and only when the user acts in the side panel.
  - `storage`:
    > chrome.storage.local keeps the user's settings (which AI assistant they use, display options) and the lessons
    > collected from assistant replies, on the user's own computer. chrome.storage.session passes a snapshot of the
    > sequence's logic map from the side panel to the map tab it opens, and is cleared when the browser closes.
    > Nothing is synced or sent anywhere.
  - Host permission:
    > The extension works only with the 75F Site Sequencer, a web tool hosted on 75f.io (internal.75f.io and
    > altius.75f.io). It reads the open sequence from the Sequencer's Blockly editor to export it, preview changes,
    > draw logic maps and run the simulator, and applies plans the user has reviewed and approved. It does not run
    > on any other site.
- **Remote code**: choose "No, I am not using remote code". Everything, including the Mermaid diagram library, is inside the package.
- **Data usage**: tick **Website content** only. The extension reads the Site Sequencer page's content (the open
  sequence) on this computer, at the person's request. It sends nothing to any server, including its author; ticking
  this is the safer reading of "collect", and it matches the privacy statement.
- Tick the three certifications (no selling, no unrelated use, no creditworthiness use).
- **Privacy policy**: the public link to `PRIVACY.md` from setup step 3.

## Distribution tab

- **Visibility**: Unlisted.
- **Regions**: all regions, or just the ones where colleagues work.

## Publishing an update

Automatic: raise the version in `extension/manifest.json`, push, then push a matching tag such as `v0.7.5`.
GitHub Actions uploads and submits it (setup in `docs/AUTO-DEPLOY.md`). By hand, if needed:

1. Raise `"version"` in `manifest.json` (for example 0.6.0 to 0.6.1). The store rejects a repeated number.
2. Zip the extension folder, with `manifest.json` at the top of the zip.
3. In the dashboard, open the item, choose **Package** → **Upload new package**, then **Submit for review**.
4. After approval, Chrome updates everyone automatically within a few hours. Nobody reinstalls anything.

Changes to the bundled guide reach the AI assistant only when each person refreshes it from Settings (**Download skill package**, or
**Copy instructions** and **Download knowledge file**), so mention it in your update note when the guide version changes.

## Before the first upload

- **Check with 75F.** The listing uses the 75F name and the extension works inside an internal 75F tool, so
  confirm with Engineering or IT that publishing it from your account is fine.
- **Remove the old copy.** Colleagues who loaded the unpacked folder should remove it from `chrome://extensions`
  before installing from the store, so they don't run two copies.
