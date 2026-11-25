# Sequencer Copilot: privacy statement

Sequencer Copilot is a Chrome extension made by Vinay for engineers using the 75F Site Sequencer.

**What it reads.** Only pages on 75f.io, and only the Site Sequencer canvas: the blocks of the open sequence and
the blocks offered in the palette. It reads them when you ask it to export the sequence, preview or apply a change,
or draw a logic map.

**What it keeps.** Your settings (which AI assistant you use, display options) and any lessons collected from
assistant replies, in your browser's local extension storage on this computer. A logic map snapshot is kept in the
browser's session storage until the browser closes. You can clear lessons from Settings, and removing the extension
deletes everything it stored.

**What it sends.** Nothing, unless you turn on the optional exact size check. By default the extension makes no
network requests to any server, including its author's. It has no analytics or tracking. Text reaches your AI
assistant only when you copy or download it and paste or upload it yourself.

**Optional exact size check.** If you enter the address of your own Cloudflare Worker (a workers.dev address) in
Settings and allow it when Chrome asks, the memory check sends the Python generated from the open sequence to that
address when you click **Get exact .mpy size**, and receives the size of the compiled file. Nothing is sent until
you click, and only to the address you entered. Remove the address in Settings to stop.

**Memory readings.** Controller memory readings you paste into the memory check are kept in local extension
storage on this computer.

**Third-party code.** The Mermaid diagram library (MIT licence) is bundled inside the extension and runs locally.

**Contact.** Questions about this extension: contact Vinay.

Last updated: 25 November 2026.
