# Changelog

## Unreleased

### Fixed

- Release Kiosk Satellite interaction holds after `ask_question` and `start_conversation` so music returns to normal volume and player overlays can appear again. Keep music ducked through conversation startup and TTS playback. Release holds on cancellation or failed startup while preserving microphone mute behavior (kiosk-satellite#602).
