# Geist for the native app

Geist Regular, Medium, SemiBold and Bold are bundled locally under the SIL Open
Font License (see `Geist-OFL.txt`). Source: [Google Fonts / Geist](https://github.com/google/fonts/tree/main/ofl/geist),
the same family used by the web app.

The static TTF files are embedded by the `expo-font` plugin. iOS resolves the
`Geist` family and its 400–700 weights from their font metadata; Android uses the
explicit family definitions in `app.json`. There is no runtime font download.

After adding or changing native fonts, run `bunx expo prebuild --platform ios`
and rebuild the app so the font resources are included in the binary.
