# 75F Sequencer Copilot

Chrome extension (Manifest V3) that helps AI assistants build and edit logic on the 75F Site Sequencer:
applies pasted plans, draws logic maps and simulates the sequence. Made by Vinay.

Published on the Chrome Web Store as an unlisted item (ID `iekibkclaknpabibdjffbljllmhlpfgb`).

## Layout
- `extension/`: the extension itself. Load it unpacked from here; its own `README.md` covers features.
- `store/`: store listing notes (`PUBLISHING.md`), privacy policy and listing images.
- `scripts/cws_publish.py`: uploads a zip to the store item and submits it for review.
- `.github/workflows/publish.yml`: builds on every push; publishes on a `v*` tag.
- `docs/AUTO-DEPLOY.md`: one-time setup and how to release.

## Release
Raise the version in `extension/manifest.json`, push, then push a matching tag (`v0.7.5`).
See `docs/AUTO-DEPLOY.md`.
