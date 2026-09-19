# Changelog

## Unreleased

### Added

- Hand timer pills and finished alerts to Kiosk Satellite when its native timer API is available. Kiosk shows named timers above its views, saves their dragged position and plays the bundled alert sound locally. Native taps pause or resume timers and double taps cancel them. Older kiosk apps keep the browser interface. Add the satellite-scoped `voice_satellite/pause_timer` WebSocket command for pause and resume (kiosk-satellite#612).

### Fixed

- Wait for timer sounds to finish before repeating and stop active playback when an alert is dismissed or muted. Use Kiosk Satellite's selected chime durations for local microphone timing while keeping Home Assistant sound durations for remote speakers (#179).

- Release Kiosk Satellite interaction holds after `ask_question` and `start_conversation` so music returns to normal volume and player overlays can appear again. Keep music ducked through conversation startup and TTS playback. Release holds on cancellation or failed startup while preserving microphone mute behavior (kiosk-satellite#602).
