# 75F Sequencer Copilot (Chrome MV3), v0.9.1

Made by Vinay.

A helper that sits between the 75F Site Sequencer and any AI assistant (Claude, ChatGPT, Gemini…).
The extension makes no AI calls and needs no API key. A person copies content between the two.

## Using the panel
Pick what you are doing at the top of the panel.

- **New sequence**: describe it to your assistant (nothing to attach), then paste its answer.
- **Edit this sequence**: click **Copy sequence**, paste it into your assistant with your request, then paste the
  answer. For very long sequences, **Download it as a file** and attach that instead.

Only one button is bright at a time: the next step. The panel watches the canvas for edits (not selecting, scrolling
or zooming), so **Copy sequence** lights up whenever the canvas has changed since the last copy, including right
after an apply. When nothing has changed it turns into a grey **Copy again**, which still works (for a new chat).
After reloading the Sequencer page, the panel treats the canvas as changed.

The newest answer always appears at the top of the panel, with **Apply to canvas** in its header; its changes
scroll inside the card. Applied, cancelled and replaced answers fold into **Earlier answers**, newest first.
Assistant setup sits at the bottom of the panel, since it is done once.

**Review changes** checks the answer against the live canvas and lists each change in plain words, using the
labels the editor shows ("set relay Relay 1 to On"), grouped by stack. **Apply to canvas** runs it as one
Blockly event group, so **Undo last change** (or one Ctrl+Z) reverts it all. If the answer can't be applied,
the panel explains why and **Copy message for your assistant** gives you the exact errors to paste back.

## Memory check

**Memory** (main screen) estimates whether the sequence fits the Connect Module's MicroPython heap
(11,968 bytes; the firmware takes 2,640, leaving about 9,330). It reads the Python the Sequencer generates
from the canvas (read-only, the same generator the editor uses) and shows:

- a verdict, **Fits**, **Tight** or **Likely too large**, with its confidence and the reasons. Two checks, and the
  worse one wins: total size against loads that ran and failed, and the largest function against the largest
  seen running (1,920 bytes; a function needs one unbroken piece of heap at load);
- the model's cost (measured: 29 bytes a point), the program estimate, variables and functions;
- where the program space goes, per function;
- ways to cut: repeated statement runs (loop or shared function), model points copied to a variable and read
  once, startup writes repeating a model default, and very large functions.

Until there are readings from your controller, the verdict compares block counts with the loads measured so far
(lighting and boiler sequences): block count is only a rough predictor, so confidence is low. **Add a reading**:
paste the controller's GC lines and say whether the sequence ran. Readings are kept in this browser; with at least
one load that ran and one that failed, the verdict switches to the byte estimate, and "max blk sz" readings
rescale the estimate. If the generated Python can't be found, it falls back to about 12 bytes a block.

**Get exact sizes from the 75F compiler** compiles the canvas with 75F's py-to-mpy service (the compiler the
Sequencer itself uses), from inside the Sequencer page with the person's current sign-in. The sign-in token stays in
the page: it is used only for that request and never reaches the extension or its storage. The returned .mpy is read
to get the real compiled size of the module and of each function, which then replace the estimates (the largest
function is the figure that maps to "max blk sz"). Loose blocks lying on the canvas outside Startup, Continuous and
functions are flagged too: they still compile into the program.

## Logic map

**Logic map** (main screen) opens a new tab with two views of the open sequence.

- **Flowchart** (default): the steps in running order. Each if / else if / else is a decision diamond with Yes and
  No branches; loops are diamonds with a return arrow. Neighbouring steps of the same kind share a box (readings and
  calculations, or outputs being set). Startup's configuration is one "Sets up" box, detailed beside the chart.
  Debug prints are left out.
- **Signals**: what each output, register and variable is worked out from. Inputs on the left, variables in the
  middle, outputs on the right; solid lines feed a value, dotted lines are the conditions that decide when it's written.

In a review, **See on logic map** shows the plan's dry run against the current canvas: green is added, amber has a
changed value (with the old one shown). A changed step always gets its own box. In the flowchart, removed steps are
listed beside the chart (they can't be drawn where they no longer are); in Signals they show in red, and **Changes
only** narrows the view to the change and its neighbours. On a big sequence the flowchart opens on the first change.
Blocks outside startup and continuous are counted, since they never run. The map is a snapshot and never changes
the canvas. **Copy as Mermaid** gives the diagram text for any Mermaid editor; **Download SVG** saves the picture as a standard SVG file.

The diagram is drawn with Mermaid 11 (MIT licence), bundled in `lib/`; nothing is loaded from the internet.

## Simulator

**Simulate** (main screen) opens the simulator inside the side panel. It reads the canvas and runs the
blocks against virtual inputs, so the logic can be checked before it goes to a Connect module.

- **Inputs** are found on the canvas: universal inputs, sensor and POR bus, Modbus and BACnet reads, model points.
  Each is named the way the sequence names it (its home-screen line, else the variable it's stored in) and gets a fader
  with a range from what the canvas says (thermistor 0–25,000 Ω, 4–20 mA, 0–10 V, CO2 in ppm, °F…) and a box for an
  exact value. Occupancy and digital inputs get an on/off switch. A PI controller's output is set by hand,
  since its maths on the device isn't confirmed.
- **Outputs**: relays light up, analog outputs show a 0–10 V meter, and model point, Modbus, BACnet and home-screen
  writes show their value. An output not written in the last run keeps its last value and is marked **held**, as on
  the controller, which shows a branch that forgets to command it.
- **Runs** like the device as far as it's known: startup once, then each continuous block at its own rate. Variables
  carry over between runs. Inputs apply on the next run; **Step** runs one now, **Restart** runs startup again.
- **Variables** and **Last run** (a trace of each step and decision) show why the outputs are what they are.
- Blocks it can't model are listed at the top and read as 0, never guessed. Delays are noted but not timed.
- After editing the canvas, read it again with the refresh button; input values you'd set are kept.

## Settings (gear icon)
- **AI assistant setup**: choose ChatGPT (skill), Google Antigravity (skill), Microsoft 365 Copilot (agent),
  Claude (Project) or another assistant, and follow the numbered steps shown for it.
  **Download skill package** gives `75f-sequencer-copilot.zip`: a `75f-sequencer-copilot/` folder with `SKILL.md`
  (the instructions, untrimmed) and `references/75f-sequencer-block-reference.md` (the block guide plus every block in
  the palette). It is the open Agent Skills format, so the same zip works for ChatGPT skills, Antigravity
  (`.agents/skills/`) and Claude skills. ChatGPT custom GPTs retire on 11 Dec 2026, so they are no longer offered.
  **Download knowledge file** gives the same reference on its own (.txt for Copilot); **Copy instructions** gives the
  text for an instructions box (trimmed to 8,000 characters if needed).
  Do this once, and again when the guide version changes. See `TESTING-CHATGPT.md` for test requests.
- **Change preview**: show or hide block types under each change.
- **Lessons to review**: findings the assistant reports in a `findings` block, plus answers the extension
  rejected or repaired. All unreviewed; check them before moving any into the block guide.

Pasted plans are read forgivingly: harmless format slips (fields written as an object, unquoted numbers, comments,
trailing commas, wrong step order) are repaired and listed on the plan card. Anything that changes meaning (unknown
blocks or ids, invalid dropdown values, numbers outside a field's range) is rejected.

## Install (unpacked)
1. If an older version is installed, **Remove** it first (this also deletes any old Gemini API key it stored).
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder.
3. Open (or reload) the Site Sequencer at `https://internal.75f.io/site-sequencer` or `https://altius.75f.io/site-sequencer` and click the toolbar icon.

## The block guide
`src/guide/block-guide.md` is the hand-written, permanent description of the blocks. Every statement is tagged
**[VERIFIED]**, **[OBSERVED]** or **[NEEDS VERIFICATION]**. The last section collects the open questions for
75F engineers. Edit the file directly, then reload the extension; the next export includes the change.
The output contract at the top of the guide is the answer format. `{{PLAN_SCHEMA}}`, `{{PLAN_EXAMPLE}}` and
`{{OPS_GUIDE}}` are filled in from `src/ops.js`, the single definition of the plan format.
Model points, the two-round model flow and functions are covered in the guide's own sections.

## How it works
```
Side panel ──runtime msg──▶ Service worker ──tabs msg──▶ Isolated content script
 (export, paste,            (finds the tab and the         (relay, request ids)
  preview, apply)            frame drawing the canvas)          │ window.postMessage
                                                                 ▼
                                                   MAIN-world bridge ──▶ Blockly 10 (in an iframe)
                                                   (context, catalog, validate, apply, undo)
```
Plans are never executed as code: only six whitelisted operations (`create`, `setField`, `connect`,
`disconnect`, `move`, `delete`) are validated and applied.

## Notes
- The Sequencer bundles Blockly inside an iframe via webpack; the bridge finds it there. A build change on
  75F's side could break this. Exposing `window.Blockly` in internal builds would make it robust.
- Exports contain site logic and point names. Check 75F's data policy before sharing them with an assistant.
