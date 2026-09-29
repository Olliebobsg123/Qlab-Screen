# QLab Connect

QLab Connect is a Node.js web monitor for a remote QLab workspace. It is designed for show relay screens, backstage displays, and TV dashboards where people need to see what QLab is doing.

It is read-only by default. An admin can optionally turn on remote control (GO, stop, pause, panic) for a stage manager page, MIDI keyboards plugged into any device on the network, and Stream Deck / Companion buttons.

The app connects to QLab over TCP OSC, reads cue information, watches what is running, and serves browser views for operators and displays.

## Features

- QLab connection using OSC over TCP (read-only unless control is turned on).
- Standby / "next GO" cue with its QLab notes on every screen.
- Show clock, interval countdown and a GO log you can export as a CSV show report.
- Countdown warnings: running cues turn amber at 10 seconds left and flash red at 5.
- Department views (sound, lighting, video, stage, show control, or a custom filter).
- Backstage paging: full-screen calls ("Beginners please") on every screen.
- Optional remote control page with a big GO button, hold-to-panic, and cue-by-number.
- MIDI control from a keyboard plugged into any device on the network (Web MIDI).
- HTTP control API for Stream Deck, Bitfocus Companion and scripts.
- Live audio meters on the TV dashboard, fed from any device that can hear the show.
- Network addresses printed at startup and QR codes on the admin page.
- Admin-protected saved connection settings.
- Main monitor view showing:

   - workspace name as the main heading
   - cue order
   - running cues
   - elapsed/remaining time where QLab exposes it
   - current cue group
   - automatic scrolling to the active cue
   - mobile at-a-glance layout
   - QLab-inspired cue styling with larger group rows and cue color swatches
   - blank memo cues left blank instead of being labeled as untitled

- TV dashboard view for full-screen display.
- Live viewers page showing who is connected to the monitor and dashboard.
- Lightweight browser updates:

   - full cue list is sent only on initial load or cue-list changes
   - routine updates send small status/running/timing patches

- Browser-to-server disconnect detection.
- Fullscreen and keep-awake controls for supported browsers.
- iPhone/iPad fallback flow using Add to Home Screen and Focus Mode.
- Proxy-aware viewer tracking using forwarded client IP headers.
- No QLab playback, edit, stop, start, or control commands.

## Screens

- Main monitor: `http://localhost:3030/`
- Admin settings: `http://localhost:3030/admin.html`
- TV dashboard: `http://localhost:3030/dashboard.html`
- Live viewers: `http://localhost:3030/viewers.html`
- Start page: `http://localhost:3030/start.html`
- Departments (including the Stage Manager): `http://localhost:3030/login.html`
- MIDI control: `https://localhost:3443/midi.html` (must be HTTPS, see below)
- Show report: `http://localhost:3030/report.html`
- Audio meter source: `https://localhost:3443/meter-source.html`

Admin, viewers, control, MIDI, report and meter source pages use HTTP Basic Auth.

Default login:

```text
username: admin
password: thomas
```

Change these with environment variables before running in production.

## What The Views Show

### Main monitor

The main monitor is the operator-friendly page. It focuses on:

- current workspace name
- current cue group
- running cues with live timing
- full cue order
- auto-scroll to the currently active cue

On smaller screens it switches to a compact mobile layout so the running cue and cue list stay visible without the title area taking over the page.

### TV dashboard

The TV dashboard is a simplified full-screen view for relay screens and confidence displays. It emphasizes:

- current cue group
- current active cue
- progress/timing
- running cue summary

### Live viewers

The live viewers page is admin-protected and shows who is currently connected to the monitor or dashboard, including:

- page type
- IP address
- forwarded IP header information when behind a reverse proxy
- whether the page is currently visible or in the background
- connected time
- last-seen time
- user agent

## QLab Requirements

In QLab:

1. Enable OSC.
2. Create an OSC passcode with **view** access.
3. Control access is not required.
4. Make sure the machine running QLab Connect can reach the QLab Mac on TCP port `53000`.

QLab Connect uses TCP OSC because large cue-list replies can exceed UDP packet limits.

To use remote control, the passcode also needs **control** access, and control must be turned on in the admin page. Remote control needs QLab 5 for the playhead next/previous commands. On QLab 4 the app falls back to the older command names.

## Show Control Features

### Standby cue and notes

Every screen shows the cue QLab's playhead is on (the next GO) and the text from that cue's **Notes** field in QLab. Running cues show their notes too. Use notes for stage manager instructions such as "Wait for actor to sit".

### Department views

Pick a department from the drop-down on the monitor, or add it to the URL. This works on the TV dashboard too:

- `/?dept=sound`: Audio, Mic, Fade and MIDI File cues, plus cues whose names include SQ, SND, FX or SFX
- `/?dept=lighting`: Light cues, plus names with LX or LQ
- `/?dept=video`: Video, Camera, Text and Fade cues, plus names with VQ, VID, VIDEO or PROJ
- `/?dept=stage`: Memo cues, plus names with SM, DSM, FLY or STAGE
- `/?dept=show`: Network, MIDI, OSC, Timecode and Script cues
- Custom: `/?types=audio,mic&color=red&text=band` (every part is optional)

Add `&warn=15` to change when the countdown warning starts (the default is 10 seconds).

### Show clock and show report

The show clock starts on the first cue fired, or when you press **Start show** on the control page. The control page also has **Start interval** (with a planned length, so every screen counts down), **End interval** and **End show**.

Every cue that starts in QLab is logged with a timestamp. The show report page summarises the running time, interval time and stage time, and **Download CSV** exports the full log. The log is saved to `show-log.json` next to `settings.json`, so it survives a restart.

### Backstage paging

On the control page, use a preset button or type a message. Choose which screens receive it (all, TV dashboards, monitors, or one department) and when it clears itself. The call covers the screen until it expires, is cleared, or someone taps "Dismiss on this screen".

### Departments: each team controls its own cues

The QLab Mac (for example a Mac mini that also runs the show's audio) can serve every department. Each team logs in from its own phone, tablet or laptop and fires only its own cues.

1. Nothing special is needed in QLab. Departments can own cues by type. If you prefer, give a department its own cue list, or mark its cues with a colour or a prefix such as `LX`.
2. In **Admin → Departments**, press **Add department** and fill in a name, colour and password. Then choose what it owns:
   - **Cue types**, for example Audio + Mic for Sound, Video + Camera + Text for Video, Light for Lighting. Every QLab cue type is listed, and the ones in the current show are marked with counts.
   - Optionally, under **More ways to choose cues**: whole cue lists, cue colours, or name/number prefixes such as `LX`.

   A cue belongs to a department if it matches any of its types, colours or prefixes. If cue lists are also ticked, only cues in those lists count.
3. Turn on **QLab control** in Admin. The QLab passcode needs control access.
4. Each operator opens `http://<server-ip>:3030/login.html`, taps their department and enters the password.

The department page shows:

- a big **GO** with the department's next cue and its notes
  - If the department owns whole cue lists, GO uses QLab's playhead for that list.
  - Otherwise, GO steps through the department's own cues in show order. It follows the show: when the stage manager's playhead moves past the department's next cue, it jumps forward to catch up.
- **Previous/Next** to choose the next cue
- the department's running cues with **Stop** buttons, plus **Stop all my cues**
- every cue the department owns, with **Start** and **Standby**

The server checks every command. A department can't start, stop or move any cue it doesn't own, even through the API. Every department action is recorded in the show report.

A login lasts 14 days, and changing a department's password signs everyone out of it. The admin can open any department's page from **Admin → Departments → Open as admin**. Backstage pages can target a single department.

### Live timing

The server runs separate loops, so a slow or unanswered question can't hold up the others:

- **Running cue timing:** four times a second (elapsed time and pause state; durations are cached).
- **What's running:** twice a second.
- **The cue list:** twice a second. Added, renamed or deleted cues appear within about half a second, even if QLab doesn't announce the change. Screens only redraw when something actually changed.
- **Cue list playheads:** once a second. Cue carts are skipped, and a list that doesn't answer is left alone for 30 seconds.

Between readings, every screen counts running cues on smoothly (in tenths of a second). Elapsed and remaining times, progress bars and countdown warnings all move continuously.

If QLab quits, restarts or the network drops, the app reconnects by itself every few seconds. It also waits for QLab if the app starts first. A manual Disconnect stays disconnected.

### Saving your setup

In **Admin → Backup**, press **Download setup file** to save a `.qlabconnect` file (JSON inside). It holds:

- the QLab connection
- departments
- cue control and the control token
- MIDI mappings and outputs
- network MIDI devices

Keep one file per show. **Load setup file** restores it, with a preview first.

If you untick "Include passwords", the file leaves out the passwords, the QLab passcode and the control token. When it's loaded, the current ones are kept.

The monitor and TV department dropdown lists the departments set up in Admin, using the same cue ownership. The old quick filters by cue type are still there too.

### Missing cues?

The app shows **one QLab workspace**. If some cues (video, mic, camera and so on) never appear, check the summary under the connection settings in **Admin**. It lists every cue list the app receives and how many cues of each type it holds, and warns if other workspaces are open in QLab. Choose the right one under **Workspace** and press **Connect Saved**.

### Stage Manager

There's no separate control page any more. The **Stage Manager** is a department that's created automatically, and you can edit it in **Admin → Departments** but not remove it. Give it a password there, and your stage manager logs in at `/login.html` like everyone else. (`/control.html` now opens the Stage Manager page for the admin.)

Its page has:

- a big **show GO** with the standby cue and its notes, plus Previous/Next
- **Pause, Resume and Stop all**, a **hold-to-panic** button and **Hard stop** (with a confirmation)
- **start or stand by any cue by number**
- the **whole show's cue list**, grouped by cue list, with Start, Stop and Standby on every cue
- the **show clock** (start/end show, intervals with a countdown)
- **backstage calls**: presets or a typed message, to every screen, TVs, monitors or one department

What makes this the Stage Manager is a set of **powers**. Every department card in Admin has them, so any department can be given some:

| Power | What it allows |
| --- | --- |
| Show GO | GO, next and previous for the whole show |
| Stop & panic | Pause, resume, stop all, panic, hard stop |
| Any cue | See the whole show; start, stop or stand by any cue |
| Backstage calls | Send calls to screens |
| Show clock | Start and end the show and intervals |
| Start from / skip | Choose where audio and video cues start, pause and resume them, and skip or scrub while they play |

If a department has **Backstage calls**, you can also choose **who it can send calls to**: every screen, TVs, monitors, or specific departments. With none ticked, it can send calls anywhere. The server enforces this.

**Tap a cue for its options.** On department pages (including the Stage Manager's), tapping any cue opens its panel. The panel has:

- Start, Standby and Stop
- the cue's notes
- with **Start from / skip**:
  - a scrub bar to start part-way through
  - while playing: Pause/Resume, −10 s / −5 s / +5 s / +10 s, and drag-to-jump

The search box above the cue list finds a cue by number or name. Press Enter on an exact number to open it. The Stage Manager's calls and show clock are tabs next to the cue list.

Jumping and starting part-way use QLab's `loadActionAt` command. Check it behaves as expected with your QLab version in a rehearsal.

Safety measures:

- Nothing fires unless **QLab control** is on (Admin → Control) and the QLab passcode has control access.
- GO presses within 350 ms count as one.
- Panic needs a press-and-hold.
- Every action is recorded in the show report with the department's name.
- Space = GO is opt-in on each device.

### MIDI keyboards on any device

Plug a MIDI keyboard or controller into any laptop or Android device on the same network. It doesn't have to be the QLab Mac. Then:

1. On that device, open `https://<server-ip>:3443/midi.html` in Chrome, Edge, Opera or Firefox. Safari and iPhone/iPad don't support Web MIDI.
2. The first time, the browser warns about the self-signed certificate. Choose **Advanced → Proceed**, then log in with the admin account.
3. Press **Connect MIDI devices** and allow MIDI access.
4. Choose what the MIDI does. There are two modes, described below.

Each device has its own **Armed** switch. Keep the MIDI tab open while the show runs.

Browsers only allow Web MIDI on secure (HTTPS) pages, which is why the server also runs HTTPS on port 3443.

#### Pass straight through to QLab (default)

Every note, CC, program change, pitch bend and transport message from the keyboard is sent to QLab as real MIDI, so the MIDI triggers already set up on your cues fire. MIDI clock, active sensing and SysEx are not passed through.

The browser sends the messages to the server over a live connection. The server plays them out of a MIDI port:

- **The server runs on the QLab Mac (recommended):** the server creates a virtual MIDI device called **QLab Connect**. In QLab, check it is enabled as a MIDI input in Workspace Settings → MIDI. You may need to restart QLab the first time so it sees the new device.
- **The server runs on another Mac:** set up a macOS Network MIDI session between the two Macs (Audio MIDI Setup → Window → Show MIDI Studio → Network). Pick that session in the MIDI page's output list.
- **Windows:** Windows can't create virtual MIDI ports. Install loopMIDI, create a port, and pick it in the output list.

The output list is shared by everyone, because it is set on the server. Pass-through needs **QLab control** turned on in Admin.

Scripts can send raw MIDI too:

```bash
curl -X POST -H "X-Control-Token: <token>" -H "Content-Type: application/json" \
  -d '{"bytes":[144,60,100]}' http://<server-ip>:3030/api/control/midi
```

#### iPhone and iPad

Every iPhone and iPad browser, including Chrome, uses Safari's engine, which has no Web MIDI. So a web page on the iPhone can't read a plugged-in keyboard. There are two options instead.

**A real keyboard: the built-in network MIDI session.** The server runs its own network MIDI session (RTP-MIDI, also called AppleMIDI) called **QLab Connect** and announces it on the network. Anything played into it goes to the same MIDI output as the pass-through, so QLab's MIDI triggers fire. Nothing needs setting up in Audio MIDI Setup.

1. Plug the keyboard into the iPhone. On a Lightning iPhone, use the Lightning to USB 3 Camera Adapter with its charging port powered.
2. Install a free network MIDI app such as midimittr. Open it and turn its network session on, using **RTP**, not Network MIDI 2.0.
3. On the MIDI page, find the phone under **Devices on the network** and press **Connect**. The server connects out to the phone (like Audio MIDI Setup's Connect button), which avoids the Mac firewall blocking incoming connections. It remembers the device and reconnects by itself.
4. If the phone isn't listed, use **Connect by address** with the phone's IP address and port (usually 5004). You can also connect from the app to **QLab Connect** instead.

The MIDI page shows which devices are connected and the last message received. Finding devices by name uses Bonjour and needs the server to run on a Mac. Connecting by address works anywhere. The session uses UDP 5004/5005. If those ports are taken (for example by a session you made in Audio MIDI Setup), the server moves to the next free pair and prints it at startup. Set `RTP_MIDI_PORT=0` to turn the session off.

**Without a keyboard: on-screen MIDI pads.** Open `http://<server-ip>:3030/midi.html` on the phone. Tap the pads (two octaves, with a channel, velocity and octave picker, plus program change and CC buttons) to send MIDI through the same pass-through.

#### Use mappings on this page

Keys trigger this app's actions (GO, next, panic and so on) over OSC, so nothing needs setting up in QLab.

- Press **Add starter keyboard layout**, or use **Learn from MIDI**: press a key, then pick an action.
- Starter layout: C4 (60) = GO, D4 (62) = next, B3 (59) = previous, E4 (64) = pause all, F4 (65) = resume all, G4 (67) = stop all, C2 (36) = panic.
- Mappings are saved on the server and shared by every MIDI page.

### Stream Deck, Companion and scripts

Copy the control token from the admin page and send a `POST` request with an `X-Control-Token` header:

```bash
curl -X POST -H "X-Control-Token: <token>" http://<server-ip>:3030/api/control/go
curl -X POST -H "X-Control-Token: <token>" -H "Content-Type: application/json" \
  -d '{"cue":"42"}' http://<server-ip>:3030/api/control/startCue
curl -X POST -H "X-Control-Token: <token>" -H "Content-Type: application/json" \
  -d '{"text":"Places please","durationSec":60}' http://<server-ip>:3030/api/control/page
```

Actions:

- QLab commands (need control turned on): `go`, `next`, `previous`, `pause`, `resume`, `stop`, `panic`, `hardStop`, `startCue`, `stopCue`, `standby`
- Paging and show clock (always available): `page`, `clearPage`, `showStart`, `showEnd`, `intervalStart`, `intervalEnd`, `showReset`

In Bitfocus Companion, use the **Generic HTTP** module. On a Stream Deck without Companion, use a plugin that can send POST requests with headers, such as API Ninja.

### Audio meters

QLab's OSC interface doesn't stream live output levels, so meters come from a browser instead:

1. On a computer that can hear the show audio, open `/meter-source.html`. This could be the QLab Mac using a loopback device such as BlackHole, or a laptop fed from the desk.
2. Pick the input and press **Start sending levels**.

Every TV dashboard then shows live peak and RMS meters. The meters hide themselves when levels stop arriving. Audio input also needs HTTPS, unless the page is opened on the server itself at `http://localhost`.

## Local Development

Install dependencies:

```bash
npm install
```

Run:

```bash
npm start
```

Optional development mode:

```bash
npm run dev
```

Then open:

```text
http://localhost:3030
```

## Configuration

Environment variables:

```bash
PORT=3030
QLAB_TCP_PORT=53000
ADMIN_USER=admin
ADMIN_PASSWORD=thomas
HTTPS_PORT=3443          # 0 turns HTTPS off
RTP_MIDI_PORT=5004       # network MIDI session (uses this port and the next); 0 turns it off
TLS_CERT_PATH=           # optional: your own certificate instead of the self-signed one
TLS_KEY_PATH=
```

When `TLS_CERT_PATH` and `TLS_KEY_PATH` are not set, a self-signed certificate is created in `tls/` next to `settings.json`. It covers `localhost`, the machine's hostname and its current LAN IP addresses, and is regenerated when those addresses change.

At startup the server prints the addresses other devices can use:

```text
Open from other devices on this network:
  http://192.168.1.50:3030   (MIDI/control: https://192.168.1.50:3443/midi.html)
```

The admin page shows the same links as QR codes.

Saved QLab connection details are stored in `settings.json` at the project root. This file can contain a QLab host/passcode, so it is intentionally ignored by Git.

Example `settings.json`:

```json
{
  "host": "10.0.4.189",
  "passcode": "1235",
  "workspaceId": "",
  "autoConnect": true
}
```

You normally do not need to edit this file directly. Use the admin page instead.

## Reverse Proxy Notes

QLab Connect can sit behind a reverse proxy. For live viewer tracking, the app prefers these headers in order:

1. `X-Forwarded-For`
2. `X-Real-IP`
3. the direct socket address

If you want the viewers page to show real remote client IPs, make sure your proxy forwards `X-Forwarded-For` or `X-Real-IP`.

## Browser Notes

- Fullscreen works in browsers that support the Fullscreen API.
- Keep Awake uses the Screen Wake Lock API where supported.
- iPhone/iPad Safari does not support normal webpage fullscreen. The best experience there is:

  1. open the page in Safari
  2. use **Add to Home Screen**
  3. launch it from the Home Screen
  4. use **Focus Mode**

- The app tries to keep the device awake after user interaction where the browser allows it, but iOS still applies platform limits.

## Project Structure

```text
server.js                 App entry point
src/config.js             Paths, ports, environment config
src/http-server.js        HTTP routes and API handlers
src/http-utils.js         JSON responses, request body parsing, static files
src/auth.js               HTTP Basic Auth for admin routes
src/settings.js           Load/save public and private settings
src/state.js              Shared app state and lightweight patch tracking
src/events.js             Server-Sent Events snapshots, patches, heartbeat
src/qlab.js               QLab TCP OSC connection, polling, timing
src/osc.js                OSC and SLIP encode/decode helpers
src/cues.js               Cue flattening helpers
src/viewers.js            Live viewer tracking and presence state
src/control.js            Control actions (GO, panic, paging, show clock) and token auth
src/show.js               Show clock, intervals, GO log and CSV report
src/paging.js             Backstage paging message
src/network.js            LAN addresses and QR codes
src/tls.js                Self-signed HTTPS certificate for Web MIDI / audio input
src/midi-out.js           MIDI pass-through: WebSocket from the MIDI page to a MIDI output port
src/departments.js        Department logins, cue ownership and department actions
src/lighting-desk.js      Lighting desk link (QLab cues tagged LX 5 → desk OSC GO)
src/cuelights.js          Standbys (standby / standing by / GO per department)
src/qlab-check.js         "Check QLab" in Admin
scripts/mac-service.sh    Run as a macOS background service (npm run mac:install)
src/rtp-midi.js           Built-in network MIDI (RTP-MIDI) session "QLab Connect" for iPhones etc.
public/shared.js          Browser helpers: departments, standby, show clock, paging overlay
public/                   Browser UI
deploy/qlabconnect.service systemd unit
scripts/install-ubuntu.sh Ubuntu installer
```

## Run it as a service on a Mac (recommended for shows)

On the Mac that hosts QLab Connect (for example the QLab Mac mini), in the QLab Connect folder:

```bash
npm run mac:install     # install and start; asks you to choose an admin password the first time
npm run mac:restart     # after updating with git pull
npm run mac:status      # is it running? (plus the last log lines)
npm run mac:logs        # follow the log
npm run mac:uninstall   # stop and remove it
```

Installed this way, it:

- starts when the Mac logs in
- restarts itself within seconds if it ever stops
- keeps the Mac from going to sleep while it runs

The log is in `~/Library/Logs/QLab Connect/server.log`. For a show Mac, also:

- turn on **automatic login** (System Settings → Users & Groups)
- let it **start up after a power failure** (System Settings → Energy)

The **admin login** is saved in settings and can be changed any time in **Admin → Server**. The change applies immediately. `ADMIN_USER` / `ADMIN_PASSWORD` environment variables still override it if you set them. Admin shows a warning while the default password is in use.

## Check QLab

**Admin → QLab → Check QLab** finds out what your QLab version and passcode support, and only reads from QLab. It checks:

- the QLab version
- whether the passcode has **control** access
- response time
- cue lists and carts
- reading the playhead, cue lengths and notes
- whether QLab announces changes

Optionally, pick a cue to test with. It plays for a few seconds, so use a quiet or silent one. This checks starting part-way through, jumping while playing, pause/resume and stop. If this QLab can't jump a playing cue, the app switches to a backup method automatically: stop, move, restart, with a very short gap.

## Standbys (cue lights)

The Stage Manager, and any department with the **Backstage calls** power, has a **Standbys** tab listing the departments it may signal. It works for any kind of cue: sound, lighting, projection, anything. For each department:

1. Pick one of that department's cues (it starts on the department's next cue) and press **Standby**. That department's page shows a flashing amber **STANDBY** banner with the cue, and phones that support it vibrate.
2. The operator taps **Standing by**, and the Stage Manager sees "Standing by ✓".
3. The Stage Manager presses **GO**. The banner flashes green, then clears itself after a few seconds. **✕** clears a standby early.

A Monitor or TV filtered to a department (`?dept=<id>`) shows that department's standbys too, without the button. Every standby, acknowledgement and GO is recorded in the show report. The "can send calls to" limits apply to standbys as well.

### Follow standbys

Tick **Follow standbys** on a department in Admin → Departments. When the stage manager calls a standby for one of its cues, that cue becomes the department's next cue, so its big GO fires it. The GO card turns amber and says who called the standby. Nothing pops up over the GO button: tap **Options** on the card for the cue's start-from bar, pause and stop. Departments with this on show "follows" in the Standbys tab.

## Lighting desk (free with any QLab licence)

QLab needs a paid licence to send OSC or MIDI, but QLab Connect can send it for you. Tag QLab cues with a desk cue number and QLab Connect sends the lighting desk a GO when that cue starts.

1. **Admin → Lighting desk**: tick *Send GOs to the lighting desk*, enter the desk's IP address, and save. The defaults are for a Zero 88 FLX / FLX S24 / FLX S48: port 8830 and the command `/zeros/cue/go/{cue}`.
2. In QLab, name a cue **LX 5** (or put **[LX 5]** anywhere in its name, e.g. *Thunder [LX 5]*). When it starts, the desk runs its cue 5. Cue numbers like 5.5 work too. The tag can be changed from "LX".
3. Press **Send test GO** to check the desk responds.

More tags (Zero 88 ZerOS commands, from Zero 88's OSC guide):

| Tag | Desk does | OSC sent |
|---|---|---|
| `LX 5` | GO cue 5 | the command set in Admin, `/zeros/cue/go/5` by default |
| `LX 2/5` | GO cue 5 on playback 2 | `/zeros/cue/go/2/5` |
| `LXP 2` | GO playback 2 (its next cue) | `/zeros/playback/go/2` |
| `LXR 2` | Release playback 2 | `/zeros/playback/release/2` |
| `LXM 3` | Run macro 3 | `/zeros/macro/3` |

All of them work at the start of a cue's name or number, or in [brackets] anywhere in its name. The test box takes the same short forms: `5`, `2/5`, `P2`, `R2`, `M3`. The desk never replies, so watch the desk itself.

On the FLX: ZerOS 7.14 or newer, a fixed IP address on the same network as the Mac, and OSC turned on in Setup → Triggers, set to **TCP**, port 8830. If a cue doesn't fire, try the command `/zeros/cue/go/1/{cue}`.

### Knowing the desk got it

The desk never answers OSC, so QLab Connect uses the connection itself as the check:

- **TCP (recommended):** QLab Connect keeps a connection open to the desk's OSC port. The light in Admin → Lighting desk is green only while that connection is up, and each GO is written straight into it and marked **✓ Delivered**. If the connection drops (desk rebooted, cable out), the light goes red, QLab Connect reconnects on its own, and a GO fired meanwhile makes it try to reconnect immediately. A GO that still can't get through is marked **✕ Failed**.
- **UDP:** GOs are sent but can't be confirmed. The light only shows whether the desk answers a ping.

### Seeing the lights change (desk output watcher)

"Delivered" proves the desk received the command, not that it did anything. If the desk sends its lighting output over the network (Art-Net, or sACN), tick **Watch the desk's lighting output** in Admin → Lighting desk (for sACN, list the universes, e.g. `1, 2`). QLab Connect then listens to the desk's output (only packets from the desk's IP address, so QLab's own Art-Net doesn't count):

- After each GO it watches for 3 seconds: **💡 Lights changed** (with which channel moved, and how soon), or **No change seen on the desk**, which is logged in the report.
- The Desk chip on department pages shows "LX 5 ✓ lights changed" or "LX 5: no change on desk".
- Admin shows a live grid of all 512 channels, brighter squares for higher levels.

On the FLX, the network output is set in Setup (DMX outputs / Art-Net / sACN). If the rig is only fed from the 5-pin DMX socket, turn on Art-Net or sACN output too. It doesn't need anything plugged in to be heard. A cue that doesn't change any levels (or has a long delay before it fades) will show "no change".

Every department page shows a **Desk** chip while the link is on: "Desk ✓" when connected, "Desk offline" when not, and for a few seconds after each lighting GO "LX 5 → desk ✓" (or "LX 5 failed"). Every GO, delivered or failed, is in the show report.

**Memo cues:** a Memo cue finishes the instant it starts, so QLab Connect can't see it run. A tagged Memo cue still fires the desk when it's started from QLab Connect (Stage Manager or department GO, tapping the cue, MIDI or Stream Deck GO), because QLab Connect knows which cue it just started. When GO is pressed in QLab itself, it can't be seen, so use a cue that lasts a moment instead: a Wait cue of half a second or more named `LX 5`, a Group, or the sound cue itself (`Thunder [LX 5]`). Admin → Lighting desk lists every tagged cue in the workspace and warns about ones that end instantly.

While the link is on, QLab Connect checks QLab about 12 times a second, so the desk GO lands within about a tenth of a second of QLab's. Cues already playing when QLab Connect connects aren't sent.

## Pre-show check

Open **Check** in the menu (as the Stage Manager, or with the admin login) at the half. It gives one verdict (ready, nearly ready, or not ready) and a list of what to fix:

- **QLab:** connected, the passcode can control QLab, cue control is on, the playhead is on the first cue, nothing is still playing, no **disarmed** cues left from rehearsal, no **broken** cues (missing files, unpatched outputs).
- **Lighting desk:** the desk is connected, cues are tagged, and no tagged cue ends instantly without a pre/post-wait. It also shows desk cues fired by more than one QLab cue.
- **Departments:** each one has a password, has cues, and is **logged in right now**.
- **Leftovers:** standbys or a backstage call still showing (with buttons to clear them), testing mode on, the show clock already running, and the default admin password.

It checks again every 20 seconds while it's open.

## Who's online

Each department page checks in every 10 seconds. The Stage Manager's **Standbys** tab shows each department's status next to its name: **Online**, **Open (screen off / in background)**, or **Last seen 5 min ago**. That way you know before you send a standby whether anyone is there to see it. The pre-show check uses the same information. "Open as admin" views don't count.

### Automatic standbys

In Admin → Departments, set **Automatic standby** on a department: *when its cue is the next GO*, or *1, 2, 3 or 5 cues before*. As the show's playhead gets that close to the department's next cue, its standby light comes on by itself with the cue named. When that cue plays (whoever fires it) the light shows GO and clears; if the show moves past it without playing it, the light clears. The Stage Manager sees "auto" next to these in the Standbys tab. A standby the Stage Manager sends by hand is never changed. This counts cues in the main cue list, so it works for cues in the show's list (a department that runs its own separate cue list isn't counted).

## Rehearsal notes

In tech, anyone can tap one of their cues (or **Options** on the GO card), type a note in the box at the bottom of the cue panel and press **Add note**. It's added to the end of that cue's notes in QLab, stamped with the department and time, e.g. `[Sound 19:42] fade too slow`, so it's there when you sit down to fix things. Every note also goes into the show report (Report page and CSV) as a single list.

Writing into QLab needs the OSC passcode to have **edit** access (QLab → Workspace Settings → Network). Without it the note is still saved in the report, and the page says why it didn't reach QLab.

## Show timing report (night by night)

Every time the Stage Manager presses **End show** (Clock tab), the performance is saved: each act's length, each interval, and when every cue was reached in running time (intervals left out, so a long interval doesn't make all of Act 2 look late). Starting a new show without ending the last one, or resetting the report, keeps it too, marked "not ended". Shows shorter than 5 minutes aren't kept.

The **Report** page then shows:

- **Performances**: one row per show with Act 1, Interval, Act 2, running time and total, each compared with the average of the other shows (red = longer by a minute or more, green = shorter). Give each a name, e.g. "Opening night", or delete a rehearsal.
- A headline for the latest show, e.g. "ran 3:45 long, Act 1 +2:55, Act 2 +0:50".
- **Where the time went**: the stretches between two cues that took longest compared with other nights, e.g. "+2:55 between 5 Scene 1 and 12 Storm".
- **Cue timings**: when each cue was reached, night by night.

Up to 80 performances are kept, in `performances.json` next to the settings file.

## Testing mode

Normally a department login belongs to the whole browser, so logging out in one tab logs out every tab. To try several departments on one device (Sound in one tab, Stage Manager in another), turn on **Admin → Server → Testing mode**. Each tab then logs in on its own, and the login lasts until the tab is closed. Turn it off for shows.

## Ubuntu Service Install

The installer creates:

- application directory: `/var/QlabConnect/app`
- environment file: `/etc/qlabconnect.env`
- systemd service: `qlabconnect.service`

It installs Node.js if needed, clones your GitHub repository, installs production dependencies, creates a starter `settings.json`, enables the service, and starts it on boot. The installer and systemd service run as `root`.

### Run From GitHub

After this repo is on GitHub, replace the URLs below with your own repository details.

```bash
curl -fsSL https://raw.githubusercontent.com/thomasdye12/Qlab-Screen/main/scripts/install-ubuntu.sh \
  | sudo REPO_URL=https://github.com/thomasdye12/Qlab-Screen.git bash
```

## Service Commands

Check status:

```bash
sudo systemctl status qlabconnect
```

View logs:

```bash
sudo journalctl -u qlabconnect -f
```

Restart:

```bash
sudo systemctl restart qlabconnect
```

Stop:

```bash
sudo systemctl stop qlabconnect
```

Edit environment variables:

```bash
sudo nano /etc/qlabconnect.env
sudo systemctl restart qlabconnect
```

## Updating On Ubuntu

Re-run the installer with the same `REPO_URL`, or update manually:

```bash
cd /var/QlabConnect/app
sudo git pull
sudo npm ci --omit=dev
sudo systemctl restart qlabconnect
```

If you only changed frontend files in `public/`, a restart is usually not required. After `git pull`, the new static files will be served on the next page load. Restart the service when backend files such as `server.js`, `src/*.js`, `package.json`, or environment settings change.

## Security Notes

- This app is intended for trusted production/show networks.
- Admin settings are protected with HTTP Basic Auth.
- The live viewers page is also protected with HTTP Basic Auth.
- Use a strong `ADMIN_PASSWORD` in `/etc/qlabconnect.env`.
- Use a QLab passcode with view-only access unless you need remote control.
- Remote control is off by default. When it's on, anyone with the admin login or the control token can fire cues, so treat the token like a password and use **New token** if it leaks.
- Connecting and disconnecting QLab (`/api/connect`, `/api/disconnect`) require the admin login.
- Do not expose this service directly to the public internet.

## License
