# OpenSousVide

Open-source apps for controlling a ChefSteps Joule sous vide directly over
Bluetooth, without the official app, a ChefSteps account, or the cloud.

This builds on the reverse-engineering notes in
[mitchcapper/JouleUWP](https://github.com/mitchcapper/JouleUWP).

## Layout

- [`python/`](python): command-line app (`joule scan`, `pair`, `set`, `status`, `watch`, `stop`).
- [`mobile/`](mobile): React Native (Expo) app for Android.
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md): the Joule's Bluetooth protocol.
- [`proto/`](proto): protobuf message definitions shared by both apps. They come
  from the official Joule Android app.
