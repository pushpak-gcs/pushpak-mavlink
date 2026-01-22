# @pushpak/mavlink

MAVLink core and transport layer for PUSHPAK GCS.

## Responsibility
- Handle MAVLink communication
- Abstract transport (USB / UDP / TCP)
- Emit MAVLink-related events

## Non-Goals
- UI logic
- Vehicle state
- Mission planning

## Status
Early development

## Example

Run the compiled example which starts the `MavlinkService` and logs events:

```bash
npm run example
```

This will compile the TypeScript sources to `dist/` and run `dist/example.js`.
