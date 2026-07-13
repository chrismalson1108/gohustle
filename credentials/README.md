# credentials/

Local-only signing/submission secrets. **Nothing secret in here is committed** —
`.gitignore` blocks `*.p8`, `*.p12`, `*.key`, `*.pem`, `*.jks`, `*.mobileprovision`.

## App Store Connect API key (for `eas submit`)

1. App Store Connect → **Users and Access → Integrations → App Store Connect API**.
2. Generate an **API Key** with role **App Manager** (or Admin).
3. Download the `.p8` **once** (Apple only lets you download it a single time) and save it here as:

   ```
   credentials/asc_api_key.p8
   ```

4. Copy the **Key ID** and **Issuer ID** shown on that page into `eas.json`
   (`submit.production.ios.ascApiKeyId` / `ascApiKeyIssuerId`), and the app's numeric
   ID (App Store Connect → your app → App Information → "Apple ID") into `ascAppId`.

The `.p8` is a secret — treat it like a password. If it leaks, revoke it in App Store
Connect and generate a new one.
