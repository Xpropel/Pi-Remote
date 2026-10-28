English | [简体中文](README.zh-CN.md)

# pi-remote

Your pi session, running on your computer, mirrored into the browser on your phone.

[![License](https://img.shields.io/github/license/Xpropel/pi-remote)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-339933)](package.json)

I spend a lot of time in the terminal with [pi](https://github.com/earendil-works/pi), and sessions tend to run long. I don't always want to sit at my desk while one finishes. pi-remote exists so I can pick my phone up, open a web page, and see the same live session — read what the agent is doing, send a message, steer it, then put the phone away. The session itself never leaves the terminal it started in.

It doesn't patch pi or scrape the terminal. Everything goes through pi's official extension API (event subscription plus `sendUserMessage` injection), so pi upgrades don't break it and there's no fork to maintain.

<p align="center">
  <img src="assets/readme/desktop-session-list.png" alt="pi-remote desktop UI" width="100%">
</p>
<p align="center"><sub>Screenshots use demo data from the built-in development gallery, not real sessions.</sub></p>

## How it fits together

```
pi on your machine ──extension──▶ relay (a small server) ──▶ browser on phone / another computer
```

- The **extension** (`extension/pi-remote-sync.ts`) lives inside the pi process. It streams session events out and delivers remote messages and commands back in. Switching models, changing the thinking level, compacting, forking a session — all of that is a command the browser sends and pi executes locally.
- The **relay** (`relay/`) is a small Node service that forwards frames and keeps the session index. It never has your model keys or your code. It only moves JSON around.
- The **web UI** (`ui/`) is what you open in the browser. Desktop and mobile get their own layouts, and there are six skins (Cursor / Claude / Codex looks, dark and light) if you get bored of one.

Several machines can connect to the same relay at once, and the UI shows which are online and what sessions each one has.

## Try it locally first

No server needed — the whole loop runs on one machine. You need Node ≥ 22.18 and pi installed globally.

Windows:

```powershell
npm install
npm run relay          # listens on 127.0.0.1:7001 (extension) and 7002 (web UI)
deploy\start-pi.cmd    # in a second terminal: starts pi wired up to the relay
```

macOS / Linux:

```bash
npm install
npm run relay
node deploy/setup.cjs ws://127.0.0.1:7001
deploy/sync-extension.sh   # installs the extension into ~/.pi/agent/extensions/
deploy/attach.sh           # opens the attach window; your machine comes online
deploy/start-pi.sh         # in a second terminal: starts pi
```

Then open `http://127.0.0.1:7002` and enter the viewer token from your `.env`. You should see the session from your terminal.

For real use, the relay runs on a small server of yours (under systemd), and on your machine you open the attach window before starting pi. Server setup, token rotation and troubleshooting live in [deploy/README.md](deploy/README.md) — it goes into much more detail than this page.

**The attach window is a physical switch.** While it's open, your machine is reachable. Close it and the extension disconnects immediately; nothing remote can touch your computer. I like that it's that simple.

## Security, in plain words

- There are two tokens: one for the extension talking to the relay, one for logging into the web UI (the viewer token). Both config files are gitignored. Don't commit them.
- **Treat the viewer token like a password.** Anyone holding it can send prompts to your pi, and pi runs with tool permissions — that's effectively remote control of your machine. Don't expose port 7002 to the open internet as-is: keep it on your own network or a tunnel, or put an HTTPS reverse proxy in front.
- The extension channel binds to localhost by default, and remote bash is off unless you explicitly enable it on the machine itself.
- Conversation content is forwarded, not stored, by default. Persistence is an opt-in switch, and stored data cleans itself up after 30 days.

## Where it stands, honestly

I use this every day, so it's past the demo stage. It's also built around one person's habits, and a few edges are still rough:

- Long transcripts aren't truly virtualized yet. The UI mounts the most recent 300 messages and pages older ones in on demand. Fine day to day, tedious in very long sessions.
- Windows and macOS are the platforms I actually test on. The Linux local side works through tmux, but I use it less, so it may have more sharp corners than I know about.
- The UI moves fast and the docs occasionally lag the code. If something here doesn't match reality, an issue is welcome.

## Digging deeper

- Deployment and troubleshooting: [deploy/README.md](deploy/README.md)
- UI development: [ui/README.md](ui/README.md)
- Exact sync protocol and command shapes: [readyUI/data-interface.md](readyUI/data-interface.md)

## Contributing

PRs are welcome. Run `npm test` before submitting (it needs neither pi nor a model), and for UI changes also `cd ui && npx tsc -b && npm run build`. Please don't commit `.env` files, tokens, or real session content. For security issues, use the repository's private reporting channel instead of a public issue.

## License

MIT — see [LICENSE](LICENSE).
