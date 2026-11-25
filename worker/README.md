# mpy-size Worker

Optional helper for the Sequencer Copilot **Memory check**. The extension posts the canvas's
generated Python here; the Worker forwards it to the 75F py-to-mpy service and returns the size
of the `.mpy` file as `{ "bytes": 1234 }`. Nothing is stored.

## Before deploying: confirm the request format
The format the py-to-mpy service expects hasn't been checked yet. In the Sequencer, open
DevTools → Network, do whatever produces the controller program, click the `py-to-mpy` request
and note:
- **Request**: is the body JSON (which field holds the code?), a file upload (which form field?),
  or plain text? Any auth header?
- **Response**: a binary `.mpy` file (starts with `M`), or JSON / base64?

Set `UPSTREAM_MODE` (`json`, `multipart` or `raw`) and `UPSTREAM_FIELD` in `wrangler.toml` to
match. If the service needs an auth header, store it as a secret:
`npx wrangler secret put UPSTREAM_AUTH` (value like `Authorization: Bearer …`).

## Deploy
```
cd worker
npx wrangler login
npx wrangler deploy
```
Wrangler prints the address (e.g. `https://mpy-size.<account>.workers.dev`). Paste it into the
extension: **Settings → Exact .mpy size → Save**. Chrome asks once to allow that address.

To accept calls only from the extension, uncomment `ALLOWED_ORIGIN` in `wrangler.toml`.

## Test
```
curl -X POST --data-binary @main.py https://mpy-size.<account>.workers.dev
```
