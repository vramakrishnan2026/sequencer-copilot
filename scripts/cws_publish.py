#!/usr/bin/env python3
"""
Upload a zip to an existing Chrome Web Store item and submit it for review (Chrome Web Store API V2).

Environment:
  CWS_SERVICE_ACCOUNT_JSON  the service account's JSON key (the whole file's text)
  CWS_PUBLISHER_ID          publisher ID, from the Developer Dashboard's Account section
  CWS_EXTENSION_ID          the item's ID
  CWS_PUBLISH_TYPE          optional: DEFAULT_PUBLISH (go live after review) or STAGED_PUBLISH
                            (after review, wait for a manual publish). Default: DEFAULT_PUBLISH.

Usage: python scripts/cws_publish.py dist/extension.zip [--upload-only]
"""
import json
import os
import sys
import time

import requests
from google.auth.transport.requests import Request
from google.oauth2 import service_account

SCOPE = "https://www.googleapis.com/auth/chromewebstore"
API = "https://chromewebstore.googleapis.com"


def require(*names):
    missing = [n for n in names if not os.environ.get(n, "").strip()]
    if missing:
        sys.exit("Missing " + ", ".join(missing) + ". Add them to the chrome-web-store environment in the repo's "
                 "Settings > Environments (see docs/AUTO-DEPLOY.md). Nothing was uploaded.")


def token():
    info = json.loads(os.environ["CWS_SERVICE_ACCOUNT_JSON"])
    creds = service_account.Credentials.from_service_account_info(info, scopes=[SCOPE])
    creds.refresh(Request())
    return creds.token


def call(method, url, tok, **kw):
    r = requests.request(method, url, headers={"Authorization": f"Bearer {tok}", **kw.pop("headers", {})}, timeout=300, **kw)
    body = r.text
    try:
        body = r.json()
    except ValueError:
        pass
    if not r.ok:
        sys.exit(f"{method} {url} failed ({r.status_code}): {body}")
    return body


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    zip_path = sys.argv[1]
    upload_only = "--upload-only" in sys.argv
    require("CWS_SERVICE_ACCOUNT_JSON", "CWS_PUBLISHER_ID", "CWS_EXTENSION_ID")
    pub = os.environ["CWS_PUBLISHER_ID"]
    item = os.environ["CWS_EXTENSION_ID"]
    base = f"publishers/{pub}/items/{item}"
    tok = token()

    print(f"Uploading {zip_path} ...")
    with open(zip_path, "rb") as f:
        res = call("POST", f"{API}/upload/v2/{base}:upload", tok, data=f)
    print(json.dumps(res, indent=2))

    # Large uploads are processed asynchronously: poll until the upload is no longer in progress.
    state = res.get("uploadState") if isinstance(res, dict) else None
    for _ in range(30):
        if state != "IN_PROGRESS":
            break
        time.sleep(10)
        status = call("GET", f"{API}/v2/{base}:fetchStatus", tok)
        state = status.get("lastAsyncUploadState") or status.get("uploadState")
        print(f"Upload state: {state}")
    if state not in (None, "SUCCEEDED", "SUCCESS"):
        sys.exit(f"Upload did not succeed: {state}")

    if upload_only:
        print("Uploaded. Not submitted for review (--upload-only).")
        return

    publish_type = os.environ.get("CWS_PUBLISH_TYPE") or "DEFAULT_PUBLISH"
    print(f"Submitting for review ({publish_type}) ...")
    res = call("POST", f"{API}/v2/{base}:publish", tok, json={"publishType": publish_type})
    print(json.dumps(res, indent=2))
    print("Submitted. Google reviews it before it reaches users.")


if __name__ == "__main__":
    main()
