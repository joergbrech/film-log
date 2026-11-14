# Third-party notices

Film Log's own code (everything outside `fonts/`) is under the WTFPL, see `LICENSE`.
It contains no third-party code. The repository bundles two font families, which
keep their own licence:

| Files | Work | Copyright | Licence |
|---|---|---|---|
| `fonts/familjen-grotesk-latin-*.woff2` | Familjen Grotesk | Copyright 2021 The Familjen Grotesk Project Authors (https://github.com/Familjen-Sthlm/Familjen-Grotesk) | SIL Open Font License 1.1, `fonts/OFL-FamiljenGrotesk.txt` |
| `fonts/jetbrains-mono-latin-*.woff2` | JetBrains Mono | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) | SIL Open Font License 1.1, `fonts/OFL-JetBrainsMono.txt` |

The font files are unmodified Latin subsets as distributed by the Fontsource project
(`@fontsource/familjen-grotesk` 5.3.0 and `@fontsource/jetbrains-mono` 5.3.0).

## Sample photo

`tests/fixtures/sample-scan.jpg` is a scaled-down copy of
["Waputik Range"](https://commons.wikimedia.org/wiki/File:Waputik_Range.jpg) by
Jeekyu1980, from Wikimedia Commons, licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). It also appears, cropped
by the app's layout, in `docs/screenshot-log-frame.png`. The photo and that screenshot
stay under CC BY-SA 4.0; the WTFPL does not apply to them. The photo is used only by the
test and the README, and is not part of the app. Camera, lens, film, aperture and shutter
in the sample data follow the photographer's description; the time of day, the meter
readings and the notes are made up.

## Tools

Not bundled, but used if you run the optional tools:

- `tools/tag_scans.py` calls [ExifTool](https://exiftool.org) by Phil Harvey, which you install yourself.
- `tests/e2e.js` uses [Playwright](https://playwright.dev) (Apache-2.0), installed separately for development.

The app talks to the GitHub REST API only if you switch on GitHub sync. "GitHub" is a
trademark of GitHub, Inc.; this project is not affiliated with or endorsed by GitHub,
Anthropic, or any film or camera maker whose product names appear as examples.
