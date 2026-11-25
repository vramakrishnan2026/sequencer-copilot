/**
 * mpy-size: a small Cloudflare Worker for the Sequencer Copilot memory check.
 *
 * POST the generated Python (text/plain) to this Worker. It forwards the code to the 75F
 * py-to-mpy service, and answers { bytes } with the size of the .mpy that comes back.
 * Nothing is stored.
 *
 * Settings (wrangler.toml [vars] or the dashboard):
 *   UPSTREAM       the py-to-mpy endpoint
 *   UPSTREAM_MODE  how the upstream wants the code: "json" ({ <field>: code }), "multipart"
 *                  (a file upload), or "raw" (the code as the body). Confirm against a real
 *                  request from the Sequencer (DevTools > Network > py-to-mpy).
 *   UPSTREAM_FIELD the JSON field or form field name for the code (default "code")
 *   UPSTREAM_AUTH  optional: a header line "Name: value" the upstream needs (store as a secret)
 *   ALLOWED_ORIGIN optional: chrome-extension://<id> to accept calls from that origin only
 */
const MAX_CODE = 512 * 1024;

function cors(env, origin) {
  const allow = env.ALLOWED_ORIGIN ? (origin === env.ALLOWED_ORIGIN ? origin : 'null') : '*';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

const json = (body, status, headers) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const h = cors(env, origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (request.method !== 'POST') return json({ error: 'POST the generated Python.' }, 405, h);
    if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) return json({ error: 'Origin not allowed.' }, 403, h);
    if (!env.UPSTREAM) return json({ error: 'UPSTREAM is not set on the Worker.' }, 500, h);

    const code = await request.text();
    if (!code.trim()) return json({ error: 'Empty code.' }, 400, h);
    if (code.length > MAX_CODE) return json({ error: 'Code too large.' }, 413, h);

    const field = env.UPSTREAM_FIELD || 'code';
    const mode = (env.UPSTREAM_MODE || 'json').toLowerCase();
    const headers = {};
    if (env.UPSTREAM_AUTH) {
      const i = env.UPSTREAM_AUTH.indexOf(':');
      if (i > 0) headers[env.UPSTREAM_AUTH.slice(0, i).trim()] = env.UPSTREAM_AUTH.slice(i + 1).trim();
    }
    let body;
    if (mode === 'multipart') {
      body = new FormData();
      body.append(field, new Blob([code], { type: 'text/x-python' }), 'main.py');
    } else if (mode === 'raw') {
      body = code;
      headers['content-type'] = 'text/plain';
    } else {
      body = JSON.stringify({ [field]: code });
      headers['content-type'] = 'application/json';
    }

    let res;
    try {
      res = await fetch(env.UPSTREAM, { method: 'POST', headers, body });
    } catch (err) {
      return json({ error: `Could not reach the py-to-mpy service: ${err.message}` }, 502, h);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) {
      const text = new TextDecoder().decode(bytes.slice(0, 500));
      return json({ error: `py-to-mpy answered ${res.status}: ${text}` }, 502, h);
    }
    // MicroPython .mpy files start with "M" (0x4D). If the service wraps the file in JSON or
    // base64 instead, decode it here once the real response format is confirmed.
    if (bytes[0] !== 0x4d) {
      const text = new TextDecoder().decode(bytes.slice(0, 200));
      return json({ error: 'The service did not return a raw .mpy file.', sample: text }, 502, h);
    }
    return json({ bytes: bytes.length, mpyVersion: bytes[1] }, 200, h);
  },
};
