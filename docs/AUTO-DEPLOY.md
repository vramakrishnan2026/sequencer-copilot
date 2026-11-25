# Auto-deploy to the Chrome Web Store

Pushing a version tag (for example `v0.7.5`) builds the extension zip, uploads it to the existing store item
and submits it for review. Google still reviews every update; colleagues get it automatically once it passes.

Every push to `main` also builds the zip and checks it, without touching the store. Download it from the
run's **Artifacts** to test it unpacked.

## One-time setup (about 15 minutes)

### 1. Google Cloud: a service account
1. Open the Google Cloud Console with the Google account that owns the Chrome Web Store publisher, and create a
   project (for example `sequencer-copilot-publish`).
2. In **APIs & Services → Library**, search for **Chrome Web Store API** and enable it.
3. In **IAM & Admin → Service accounts**, create a service account (for example `cws-publisher`).
   It needs no roles or permissions.
4. Open the service account, go to **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
   Treat it like a password: don't commit it, and delete your local copy after step 3 below.

### 2. Chrome Web Store: give the service account access
1. In the Chrome Web Store Developer Dashboard, open your account settings and add the service account's
   email (it ends in `iam.gserviceaccount.com`) as the service account for the API.
   Only one service account can be added per publisher.
2. Note your **Publisher ID**, shown in the dashboard's **Account** section.
3. Make sure 2-step verification is on for the publisher's Google account; publishing requires it.

### 3. GitHub: secrets
In this repo: **Settings → Environments → New environment**, name it `chrome-web-store`.

- Optional but recommended: under **Deployment protection rules**, tick **Required reviewers** and add
  yourself. Every store submission then waits for your click in the Actions tab.
- **Environment secrets**:
  - `CWS_SERVICE_ACCOUNT_JSON`: paste the whole content of the `.json` key file.
  - `CWS_PUBLISHER_ID`: the publisher ID.
- **Environment variables**:
  - `CWS_EXTENSION_ID`: `iekibkclaknpabibdjffbljllmhlpfgb`
  - `CWS_PUBLISH_TYPE` (optional): `STAGED_PUBLISH` to hold each update after review until you publish it
    in the dashboard; leave unset to go live as soon as it passes review.

## Releasing a version
1. Raise `"version"` in `extension/manifest.json` (and the version line in `extension/INSTALL.txt`).
2. Commit and push to `main`. Check the run passes.
3. Tag and push the tag:
   ```
   git tag v0.7.5
   git push origin v0.7.5
   ```
4. Watch **Actions → Build and publish**. If you set required reviewers, approve the `publish` job.
5. Check the item's status in the Developer Dashboard.

You can also run the workflow by hand: **Actions → Build and publish → Run workflow**, tick **Upload and
submit**, and choose the publish type.

The workflow refuses a tag that doesn't match the manifest version, so a forgotten version bump fails before
anything is uploaded.

## What stays manual
- Store listing text, screenshots and the Privacy tab: edit them in the dashboard (see `store/PUBLISHING.md`).
- If you change the item's visibility in the dashboard, publish once by hand with the new visibility before
  the API can publish again.
- The API can't create a new item; it only updates this one.

## Troubleshooting
- **401/403 from the API**: the service account isn't added in the Developer Dashboard, the API isn't enabled
  in the Cloud project, or the JSON secret is incomplete.
- **Upload rejected for the version**: the store already has this version number. Raise it and tag again.
- **Item in review already**: wait for the current review to finish, or cancel that submission in the dashboard.
