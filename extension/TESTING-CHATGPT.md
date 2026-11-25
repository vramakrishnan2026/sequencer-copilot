# Testing plans from ChatGPT

## One-time setup: the ChatGPT skill (recommended)
1. In the panel, open **Settings** (gear icon), choose **ChatGPT (skill)**, and click **Download skill package** (with a Site Sequencer tab open).
2. In ChatGPT: sidebar **Plugins** → **Skills** tab → **Create** → **Upload from your computer**, and choose `75f-sequencer-copilot.zip` (don't unzip it).
3. Install the skill and start a new chat. ChatGPT uses it when you ask about the Site Sequencer, or name it.

Skills are on Business, Enterprise and Edu workspaces. Custom GPTs retire on 11 Dec 2026: replace an old
75F GPT with the skill rather than migrating it, so the instructions and block list are current.

For a new sequence, just ask. To change an existing one, choose **Edit this sequence**, click **Copy sequence** and paste it (or **Download it as a file** and attach that), and ask.

Without skills (e.g. a personal plan): choose **Another assistant**, put the copied instructions in a ChatGPT
project and add the knowledge file to it, or attach the knowledge file (and, for an edit, the sequence download) in a normal chat, and
start your message with "Follow the Output contract in the file."

## Standard test requests
Run these on the test sequence (zone temperature on UI1, Relay 1 switching at 76 °F). Export fresh before
each one, then paste ChatGPT's reply into the panel and note what happened.

| # | Ask ChatGPT | A good answer |
|---|---|---|
| 1 | Also turn Relay 2 on when zoneTemp is above 76, and off otherwise. | Two new Set Relay Output blocks stacked with NEXT under the existing ones, relay value `"1"`. No deletes. |
| 2 | Change the 76 °F threshold to 74. | One `setField` changing the number block to `"74"`. Nothing else. |
| 3 | Add a fan output. | A question (which relay or output, what condition). No plan. |
| 4 | Set AO1 to 12 V when above 76. | Says the range is 0–10 V and asks. If it sends 12 anyway, the extension rejects it. |
| 5 | Remove the home screen update. | One `delete` of the Update Home Screen Input block. |
| 6 | After the if block, add: if zoneTemp is below 65 turn Relay 3 on, else off. | New `controls_if` with `extraState` `{"hasElse":true}`, compare `LT` 65, relay value `"2"`, stacked with NEXT. |
| 7 | Why might Relay 1 switch on and off rapidly around 76? | Prose only: no deadband or minimum run time. No JSON. |

## Recording results
For each run note: accepted as-is, accepted after automatic format repairs (the panel lists them), or rejected
(copy the errors back and note whether the second plan worked). Send new failure patterns back so they become
either an automatic repair in the extension or a line under "Common mistakes" in the guide.
