# Firebase setup — 20 minutes, once

No CLI needed (it requires Node.js, which this machine doesn't have).
Everything happens in the browser console.

## 1. Create the project — console.firebase.google.com

- **Add project** → name it (e.g. `peatprobe`) → Google Analytics OFF (not needed)

## 2. Authentication

- Build → **Authentication** → Get started
- Sign-in method → **Google** → Enable → set a support email → Save
- **Settings → Authorised domains → Add domain:**
  - `YOUR-USERNAME.github.io`   ← forget this and sign-in fails silently in production
  - (`localhost` is already there)

## 3. Firestore

- Build → **Firestore Database** → Create database
- Location: **europe-west2 (London)** — cannot be changed later
- Start in **production mode**
- **Rules tab** → delete everything → paste the whole of `firestore.rules`
  from this repo → **Publish**

## 4. Storage (photos)

- Build → **Storage** → Get started → same location
- This prompts an upgrade to the **Blaze** plan (pay as you go; the free
  allowances almost certainly cover you, but a card is required)
- **Rules tab** → paste the whole of `storage.rules` → **Publish**

## 5. Budget alert — do not skip

- ⚙ → Usage and billing → Details & settings → **Set a budget alert at £5**

## 6. Get the web config

- ⚙ → Project settings → Your apps → **</> (web)** → nickname `peatprobe`
  → (no hosting) → Register
- Copy the `firebaseConfig` object it shows

## 7. Wire it into the app

In `js/config.js`, set `FIREBASE.enabled = true` and paste the values:

```js
export const FIREBASE = {
  enabled: true,
  config: {
    apiKey: '...',            // fine to be public - it is an identifier,
    authDomain: '...',        // not a secret; security lives in the rules
    projectId: '...',
    storageBucket: '...',
    messagingSenderId: '...',
    appId: '...',
  },
};
```

## 8. Make yourself admin

1. Open the deployed app (or localhost) → **My data → Sync now** → sign in
   with your Google account. Your first point can sync now.
2. Firebase console → Authentication → Users → copy your **User UID**
3. Firestore → **Start collection** → id `admins` → document id = *paste your
   UID* → add any field (e.g. `note: "me"`) → Save

Nobody else can add themselves: the rules allow no client writes to `admins`.

## What you get

- Volunteers sign in with Google; measurements land in `measurements`
  with `status: pending_review`
- Photos land in Storage under `photos/<fireId>/<uuid>.jpg`
- Everyone who downloads a fire's pack sees everyone's synced points for it
- Review queue: Firestore console → filter `status == pending_review` →
  edit to `verified` (an admin-only action under the rules)

## Before volunteers — still outstanding

- **App Check** (Build → App Check, reCAPTCHA v3) — blocks scripted abuse of
  the open endpoint. Turn on *enforcement* for Firestore + Storage.
- Privacy notice + Cambridge DPO conversation.
