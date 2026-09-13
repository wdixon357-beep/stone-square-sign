# Mac update releases

The Mac app uses Sparkle to check the separate Mac release feed. A website deployment alone must never advertise a Mac update. Users choose whether to install; Sparkle verifies the signed download, installs it, and relaunches the app. Unfinished work must be saved before relaunch.

Feed: https://stone-square-sign.onrender.com/updates/appcast.xml

The Ed25519 private signing key is in this Mac's login Keychain under the `stone-square-sign` account. Only its public key belongs in the app or repository. Do not export the private key into source control or the web service.

## Release procedure

1. Set `DEVELOPER_ID_APPLICATION` to the installed Developer ID Application identity and `NOTARYTOOL_PROFILE` to a valid Apple notarization Keychain profile. Build with `DISTRIBUTION_BUILD=1 ./macos/scripts/build-app.sh`.
2. Run `node scripts/prepare-mac-update.mjs macos/dist/Stone-Square-Sign-VERSION.zip /path/to/Sparkle/bin`. This rejects local-only packages and verifies bundle identity, version, code signing, stapled notarization, Gatekeeper acceptance, and the update signature before preparing the feed.
3. Publish that exact archive in the public GitHub release tagged `vVERSION`. Verify the downloaded bytes match the prepared archive before proceeding. Do not overwrite a published release archive.
4. Copy the prepared `macos/dist/appcast.xml` to `public/updates/appcast.xml`, commit and deploy. Verify the live feed and perform an older-version install/relaunch check before calling the release complete.

Until a notarized archive is published, the feed intentionally contains no releases. Local builds may be installed on the development Mac but must not be published as update packages.

The existing installed build needs one local installation of the updater-enabled version. Subsequent eligible releases can use the in-app update flow.
