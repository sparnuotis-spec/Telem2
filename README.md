# Telem2

Telem2 is a local-network flight operations dashboard for FPV drone blackbox telemetry collection. It gives the host laptop, a second admin laptop, and phones one shared live view of sessions, pilots, rounds, scenarios, flight status, transfer work, and history.

## Run locally

```bash
npm install
npm start
```

The app listens on `0.0.0.0:5050`. On the host open `http://localhost:5050`. From another laptop or phone on the same network open `http://<host-lan-ip>:5050`. The host computer must allow inbound TCP traffic on port 5050 in its firewall.

The local database and uploaded files are stored under `data/`, which is ignored by Git. Set `TELEM2_DATA_DIR` to move them to a larger disk. Set `PORT` to change the port.

## Operating flow

1. Open **Setup**, create the date/session, and enter optional session notes.
2. Add pilots with their permanent IDs and names. Pilot IDs cannot be reassigned to another name. Each pilot gets a required `sd card` or `regular` tag; `sd card` is intentionally rendered red and `regular` uses the neutral style.
3. Open **Planning** and create rounds/windows, scenarios, and flights. Flight records include Pilot ID, UAV ID, Battery ID, CALM/DYN, W1/W2, REP, and optional notes.
4. Use **LiveView** to move flights through ready, airborne, transfer, completed, or failed states. Every connected browser refreshes through server-sent events.
5. Attach raw telemetry and video through the API endpoint when needed: `POST /api/flights/:id/files` with multipart fields `files` and `kind=raw|video`. Failed flights do not require files.
6. Use **History** to search records and **Export CSV** for an Excel-compatible export.

## Google Drive snapshot sync

The app always creates a local CSV snapshot. To upload snapshots to the telemetry destination folder, start the host with the folder ID configured:

```bash
GOOGLE_DRIVE_FOLDER_ID=<folder-id> npm start
```

The current implementation uses the installed Google Workspace CLI and uploads a dated CSV snapshot to the configured Drive folder. The `GOOGLE_DRIVE_FOLDER_ID` environment variable is intentionally not committed. If it is absent, the Sync button still creates a local export and reports that configuration is missing.

## Naming rules discovered from the telemetry folder

The source documents establish the stable technical identifiers used by Telem2:

- `Flight ID`: permanent per-real-flight identifier, formatted like `FL-000347`.
- `Pilot ID`: permanent identifier, formatted like `PILOT-004`.
- `UAV ID`: permanent physical-UAV identifier, formatted like `UAV-003`.
- `Battery ID`: permanent physical-battery identifier, formatted like `BAT-021`.
- `Scenario ID`: `SC-01` through `SC-06` in the supplied matrix.
- Mode: `CALM` or `DYN`.
- Weather group: `W1` or `W2`.
- Repeat: `REP-01` through `REP-04`.
- Original telemetry formats include BBL, BFL, DAT, TXT, and original CSV. Original video remains separate and unmodified.

The supplied workbook uses a `SKRYDzIAI` sheet with columns `Flight ID`, `Pilot ID`, `UAV ID`, `Battery ID`, `Scenario ID`, `CALM/DYN`, `W1/W2`, `REP`, `Sesija`, `Date`, `RAW Pavadinimas`, `Video Pavadinimas`, and `Sėkmingas?`. The app keeps these fields structured and keeps Flight ID as the primary traceability key.

## API health check

```bash
curl http://localhost:5050/api/health
```

## Data safety

Do not commit `data/`, Google credentials, real telemetry, or real video files. Raw files should remain original; the app stores checksums and links each file to a single Flight ID.

## Regular-pilot Betaflight mass-storage helper

For regular pilots, connect the flight controller to the transfer computer with a USB data cable. The Windows helper at `tools/betaflight-mass-storage.ps1` watches for a new serial port, verifies that the device identifies as Betaflight, and then sends the CLI sequence automatically.

Run PowerShell from the Telem2 folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\tools\betaflight-mass-storage.ps1
```

For a safer one-device/manual test, specify the COM port:

```powershell
.\tools\betaflight-mass-storage.ps1 -Port COM4
```

For normal use, start the watcher once and leave its PowerShell window open. It will keep watching for newly connected flight controllers; you do not need to paste the command for every drone. You can also double-click:

```text
tools\start-betaflight-watcher.cmd
```

To start it automatically when Windows logs in, create a shortcut to `start-betaflight-watcher.cmd`, press `Win+R`, enter `shell:startup`, and place the shortcut in that Startup folder. Keep the host computer awake and leave the watcher running during the transfer session.

The Betaflight command used for mass-storage mode is:

```text
msc
```

The helper enters the CLI with `#`, sends `version`, and sends `msc` only if the response contains `Betaflight`. The official Betaflight documentation states that `msc` reboots supported F4, G4, F7, and H7 flight controllers into USB mass-storage mode; normal flight-controller operation stops until power-cycled. This is a firmware reboot command, not a flight command, so disconnect propellers and do not use it while armed or flying.
