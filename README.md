# sowel-plugin-displays

Sowel companion plugin: MQTT supervision for Sowel-supervised displays
— vendor-agnostic.  The `sowel-energy-display` AMOLED firmware is the
first implementor; future e-paper / OLED / ePOS displays that follow
the same wire contract are auto-discovered with zero plugin change.

Pairs with the Sowel `display` equipment type (spec 120).

## What it does

- Subscribes to the configured MQTT broker on a single topic root
  (default `sowel-display/...`).
- Auto-discovers displays from their retained `state` payload — one
  Sowel `Device` per `<id>` seen.
- Maps the canonical state fields to Sowel data categories
  (firmware_version / uptime / rssi / language / display_brightness)
  + a `generic` passthrough for vendor-specific extras.
- Tracks online / offline via the LWT-driven `availability` topic.
- Translates Sowel orders (`set_language`, `set_display_brightness`,
  …) into `cmd/<key>` publishes.

## Wire contract

| Topic                              | Direction | Retained | Payload                                       |
| ---------------------------------- | --------- | -------- | --------------------------------------------- |
| `<prefix>/<id>/availability`       | sub       | yes      | `online` / `offline` (LWT publishes offline)  |
| `<prefix>/<id>/state`              | sub       | yes      | JSON, every ~30 s + on change                 |
| `<prefix>/<id>/cmd/<key>`          | pub       | no       | string (UTF-8), per the order being dispatched |

State JSON sample:

```json
{
  "id":         "sowel-display-9a3b1c",
  "version":    "1.2.1",
  "uptime_s":   12345,
  "hostname":   "sowel-display-9a3b1c",
  "ip":         "192.168.0.123",
  "rssi":       -55,
  "language":   "fr",
  "brightness": 80
}
```

`id` + `version` + `uptime_s` are mandatory; the rest is optional /
vendor-specific. See `specs/001-initial-release/spec.md` for the full
contract.

## Installation

### Via Sowel Admin (recommended)

Once published to the Sowel plugin registry (separate PR on
`mchacher/Sowel`):

1. Sowel → Admin → Plugins → Browse.
2. Pick "Sowel Displays" → Install.
3. Open the plugin's settings, fill the MQTT broker URL (the same
   broker the display publishes to).
4. The plugin connects, the display's retained state lands within
   seconds, and a `Device` appears in `Devices`. Bind it to a
   `display` equipment.

### Manually

```sh
git clone https://github.com/mchacher/sowel-plugin-displays
cd sowel-plugin-displays
npm ci && npm run build
# Then drop the directory (or the released tarball) in Sowel's
# plugins/ folder and restart Sowel.
```

## Settings

| Key             | Required | Default              | Notes                                              |
| --------------- | -------- | -------------------- | -------------------------------------------------- |
| mqtt_url        | yes      | —                    | e.g. `mqtt://192.168.0.230:1883`                   |
| mqtt_username   | no       | —                    | Anonymous broker if empty                          |
| mqtt_password   | no       | —                    |                                                    |
| mqtt_client_id  | no       | sowel-energy-display | Suffixed with a 6-char random on start             |
| topic_prefix    | no       | sowel-display        | Lets you run several MQTT topic namespaces in parallel |

## Polymorphism

The plugin is plugin-agnostic at the wire layer: any new display that
publishes to the same topic root is auto-discovered. Vendor-specific
state fields (e.g. an e-paper's `battery_pct` / `sleep_s`) land as
`generic` data on the device and surface read-only on the equipment
detail card.

Order declaration is data-driven: a display that never reports
`brightness` ends up with no `set_display_brightness` order, and the
Sowel UI hides the slider automatically. A passive single-screen,
mono-language display is a valid Sowel display, fully observable.

## Development

```sh
npm ci
npm test       # unit tests (parse-state, dispatch-order, availability)
npm run build  # tsc → dist/
```

The release workflow tags + builds + uploads a tarball when you push
a `v*` tag (`git tag v0.2.0 && git push --tags`).
