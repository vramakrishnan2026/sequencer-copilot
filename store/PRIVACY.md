# Sequencer Copilot: privacy statement

Sequencer Copilot is a Chrome extension made by Vinay for engineers using the 75F Site Sequencer.

**What it reads.** Only pages on 75f.io, and only the Site Sequencer canvas: the blocks of the open sequence and
the blocks offered in the palette. It reads them when you ask it to export the sequence, preview or apply a change,
or draw a logic map.

**What it keeps.** Your settings (which AI assistant you use, display options) and any lessons collected from
assistant replies, in your browser's local extension storage on this computer. A logic map snapshot is kept in the
browser's session storage until the browser closes. You can clear lessons from Settings, and removing the extension
deletes everything it stored.

**What it sends.** By default, nothing: the extension makes no network requests to any server, including its
author's, and has no analytics or tracking. Text reaches your AI assistant only when you copy or download it and
paste or upload it yourself.

The one exception is the memory check's **Get exact sizes from the 75F compiler** button. When you click it, the
Python generated from the open sequence is sent to 75F's own py-to-mpy compiler
(micropython-edge-api.azurewebsites.net), the same service the Site Sequencer uses when it builds a sequence, from
inside the Sequencer page and with your existing 75F sign-in. The extension never reads that sign-in into its own
storage. Nothing is sent until you click.

**Memory readings.** Controller memory readings you paste into the memory check are kept in local extension
storage on this computer.

**Third-party code.** The Mermaid diagram library (MIT licence) is bundled inside the extension and runs locally.

**Contact.** Questions about this extension: contact Vinay.

Last updated: 25 November 2026.
