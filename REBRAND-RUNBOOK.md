# Rebrand Runbook — White-Labeling a New Copy

Use this whenever a new gym/client wants their own branded copy of the tracker
(same pattern as ProteinTracker → Diet Tracker/GlobalTNF).

Budget **60–90 minutes** for a clean rebrand + deploy, more if the new brand
needs its own Firebase project set up from scratch.

---

## 0. Before you start — gather these from the client

| Item | Example | Used for |
|---|---|---|
| Brand/app name | `Diet Tracker` | Page titles, headers, admin console |
| Company/legal entity | `StrengthFocus` | Privacy policy, billing emails |
| Target domain (Firebase project ID) | `global-tnf-diet-tracker` | `.firebaserc`, all absolute URLs |
| Admin email(s) | `macmelvin.tan@gmail.com` | `ADMIN_UIDS` in Cloud Functions |
| Primary accent color (hex) | `#12b981` (teal-green) | CSS gradient vars |
| Hero image | (reuse existing or new) | Landing page hero |
| Existing Firebase project, or new one? | new | Determines steps 2–4 below |

---

## 1. Create the new repo from the template

1. Go to `github.com/macmelvin/globaltnf-diet-tracker`
2. Click **Use this template → Create a new repository**
3. Name it `<client>-diet-tracker` (or similar)
4. Clone it locally:
   ```bash
   git clone https://github.com/macmelvin/<new-repo-name>.git
   cd <new-repo-name>
   ```

---

## 2. Create the new Firebase project

1. Go to [Firebase Console](https://console.firebase.google.com) → **Add project**
2. Enable: **Hosting**, **Authentication** (Google + Email/Password), **Firestore**, **Cloud Functions**
3. In Authentication → Sign-in method, enable **Google** and **Email/Password**
4. Note the exact **Project ID** (may differ slightly from what you typed, e.g. a random suffix)

---

## 3. Point the repo at the new project

```bash
echo '{"projects":{"default":"<new-project-id>"}}' > .firebaserc
firebase use --add   # if prompted, confirm the alias
```

---

## 4. Run the rebrand script

See `rebrand.sh` in this same folder. It does a search-and-replace across
`portals/*.html` and `functions/*.js` for brand name, domain, and admin email.

```bash
chmod +x rebrand.sh
./rebrand.sh \
  --old-name "Diet Tracker" \
  --new-name "NewClient Tracker" \
  --old-domain "global-tnf-diet-tracker" \
  --new-domain "newclient-tracker" \
  --old-email "macmelvin.tan@gmail.com" \
  --new-email "admin@newclient.com"
```

**The script does NOT handle:**
- Colors (see step 5)
- Hero image / demo video (see step 6)
- Firestore security rules referencing hardcoded UIDs (check `firestore.rules` manually)
- Cloud Functions `ADMIN_UIDS` array — script updates the *email comment* but you
  still need the actual Firebase Auth **UID**, not the email, in code. Get it from
  Firebase Console → Authentication → Users, after the admin signs in once.

---

## 5. Update colors (manual)

Find these CSS custom properties near the top of each `portals/*.html` file
and adjust the gradient stops to match brand colors:

```css
--accent, --accent-ink, --accent-soft
```

Also check the SVG gradient defs (`<linearGradient id="gg">` / `id="gb"`) in
the hero ring and progress rings — these are separate from the CSS vars and
need matching manually.

---

## 6. Hero image & demo video

- Drop a new `hero.jpg` into `portals/`, or point the `<img>` tag at another
  hosted copy (see `MOBILE-LAYOUT-BUG-NOTES.md` in protein-backend for why we
  went with an external URL last time — avoids missing-file bugs).
- Copy `demo.mp4` + `demo-poster.png` into `portals/` if reusing the existing
  demo, or record a new one.

---

## 7. Deploy Cloud Functions

```bash
cd functions
npm install
firebase deploy --only functions --project <new-project-id>
```

Watch for the **two-functions-folder trap** if this client will also get a
gym/enrollment system — keep a single source of truth for `enrollments` /
`gyms` collections, don't fork the billing logic across two folders like
ProteinTracker/GlobalTNF ended up doing.

---

## 8. Firestore indexes & rules

```bash
firebase deploy --only firestore:indexes --project <new-project-id>
firebase deploy --only firestore:rules --project <new-project-id>
```

Common composite indexes this app needs (add proactively, don't wait for the
`FAILED_PRECONDITION` error in production):

- Collection group `enrollments`, fields `gymId` (Asc) + `status` (Asc)
- Collection group `enrollments`, field `gymId` (Asc) alone (for delete flows)

---

## 9. OAuth redirect URIs (Google Sign-In)

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
under the OAuth 2.0 Web client for the new project, add to
**Authorized redirect URIs**:

```
https://<new-project-id>.web.app/__/auth/handler
https://<new-project-id>.firebaseapp.com/__/auth/handler
```

And to **Authorized JavaScript origins**:

```
https://<new-project-id>.web.app
```

Takes a few minutes to propagate.

---

## 10. Deploy hosting

```bash
firebase deploy --only hosting --project <new-project-id>
```

---

## 11. Test checklist before handing off

- [ ] Google Sign-In works (no `redirect_uri_mismatch`)
- [ ] Hero image loads
- [ ] Demo video plays
- [ ] Add food → photo recognition → entry saves
- [ ] Shared plate toggle works
- [ ] Profile "Tell us about you" saves and collapses on reload
- [ ] Admin portal login works, gyms list loads
- [ ] Mobile viewport: Food input doesn't truncate, buttons wrap correctly
- [ ] Privacy policy has correct legal entity name + DPO contact (no
      leftover `[TODO: ...]` placeholders)
- [ ] `.firebaserc` is committed to the new repo (don't repeat the "No
      currently active project" issue)

---

## 12. Commit everything

```bash
git add -A
git commit -m "Rebrand: <old name> → <new name>"
git push
```
