# inthiseconomygenz.id — iPhone app

React Native + Expo (SDK 57) app built from the iOS PRD. It runs the **same engine** as the web app
(`packages/core`, bundled straight from the monorepo by Metro), on top of native SQLite (`expo-sqlite`)
instead of sql.js, so budgets, rules, templates, schedules and sync behave the same everywhere.

## Layout

```
src/
  app/                 Expo Router routes
    (tabs)/            Budget · Accounts · Reports · More (native iOS tab bar)
    add.tsx            quick-add / edit sheet (keypad, payee, category, account, date)
    budget-amount.tsx  set a category's amount for the period
    account/[id].tsx   account register (FlashList, grouped by day); id "attention" = needs review
    settings.tsx       budget month start day (1–28), Face ID lock
    server.tsx         connect to the sync server, sign in, download a budget
    welcome.tsx        first run: create a budget or connect to the server
  engine/              engine wiring: sql.js-compatible shim over expo-sqlite, device storage
                       (files in Documents/, secrets in Keychain), React provider + useEngineQuery
  lib/                 money formatting/parsing (id-ID, "25rb", "1,5jt"), i18n (id/en), toasts, periods
  ui/                  theme (light/dark), shared components, keypad, app lock
scripts/check-engine.mts  parity test: core engine on sql.js vs. this app's SQLite shim
```

## Develop (works from Windows — no Mac needed)

```sh
cd mobile
npm install
npm run typecheck && npm run lint
npm run check-engine           # engine parity test (runs from the repo root)
```

### Quick test on your iPhone with Expo Go (free, no Apple account)

Every native module the app uses (SQLite, Secure Store, Face ID, haptics, FlashList, native tabs)
ships inside Expo Go, so you can try it right away:

1. Install **Expo Go** from the App Store (it must support SDK 57).
2. On the PC: `npx expo start --go --tunnel` (`--tunnel` because the phone can't reach WSL's
   network directly; the first run asks to install `@expo/ngrok`, say yes).
3. Scan the QR code with the iPhone Camera app → opens in Expo Go. Edits on the PC reload live.

### Development build (for TestFlight-like behaviour)

Your own app icon, bundle ID and Face ID prompt text only show up in a **development build**:

```sh
npx eas-cli@latest login
npx eas-cli@latest init                       # links the project and writes extra.eas.projectId into app.json
npx eas-cli@latest device:create              # register your iPhone (open the link on the phone)
npx eas-cli@latest build --profile development --platform ios
# install the build on the phone from the link, then:
npx expo start --dev-client    # phone and PC on the same Wi-Fi (or use --tunnel)
```

EAS builds iOS in the cloud. Signing needs an Apple Developer Program membership (99 USD/year);
EAS creates and stores the certificates and profiles for you.

## TestFlight

```sh
npx eas-cli@latest build --profile production --platform ios
npx eas-cli@latest submit --platform ios      # uploads to App Store Connect; then add testers in TestFlight
```

Bundle identifier: `id.inthiseconomygenz.app` (change it in `app.json` before the first build
if you want another one). Build numbers increase automatically (`eas.json`, `autoIncrement`).

## Connecting to your server

More → Server sync → enter the address (must be **https** on a real phone, e.g. behind your
reverse proxy), sign in with username + password, then pick a budget to download. Changes sync
both ways after that, like the web app.

## Status vs. PRD

Implemented in this first cut:

- Budget tab: To Budget banner, groups and categories with balance pills, overspent highlighting,
  tap a category to set its amount; follows the custom month start day
- Accounts tab: on-/off-budget accounts with balances, "needs attention" (uncategorized) list
- Register per account, grouped by day, tap to edit; quick-add sheet with keypad, income/expense,
  payee autocomplete, category and account pickers, delete, undo toast
- Reports tab: spending this period vs. last, top categories, income vs. spending
- Settings: month start day with a live preview of period dates, Face ID lock (after 60 s in
  background) with a privacy cover in the app switcher
- Server sign-in (password) and budget download; sync via the shared engine
- Indonesian/English strings, dark mode, haptics, VoiceOver labels on the main controls

Not yet (planned in the PRD):

- **End-to-end encrypted budgets** — Hermes has no `crypto.subtle`; needs a native AES-GCM /
  PBKDF2 module. Encrypted budgets are shown but can't be downloaded yet.
- **Google sign-in** — `expo-auth-session` flow against the server's OIDC endpoints.
- Split transactions, transfers in the quick-add sheet, schedules and rules screens, imports,
  goals/templates editing, search.
- Home-screen widgets, Siri Shortcuts / App Intents, notifications (need native targets via config plugins).
- **Persistence**: the engine still persists by serializing the whole database (fine for typical
  budgets, ~1–2 MB). Moving to writing straight to the on-disk SQLite file is the next
  performance step for big budgets.
- App icon and splash are still the Expo template ones (`assets/`).
