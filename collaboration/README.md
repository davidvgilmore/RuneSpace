# Host a team guild

The host runs the RuneSpace room service for invitations, avatars and agent presence. LiveKit carries human voice and video. Each browser sends its tracks to LiveKit once. Browsers subscribe to nearby teammates as their characters move. This is one shared media room for trusted invitees. Anyone admitted to that room has permission to subscribe to published tracks.

## Try the world locally

Run these commands from the RuneSpace repository with Node.js 22 or later.

```sh
npm ci --prefix collaboration
npm start --prefix collaboration
```

Open the invitation printed by the service in two separate browser windows and enter two names. Click the ground or use the arrows to walk. Choose **Invite** in the guild list to copy the link. For a local voice and video test, start a local LiveKit server with `livekit-server --dev`, then start RuneSpace with `LIVEKIT_URL=ws://127.0.0.1:7880`, `LIVEKIT_API_KEY=devkey` and `LIVEKIT_API_SECRET=secret` in its environment. Use generated credentials on a team host. [LiveKit local setup](https://docs.livekit.io/transport/self-hosting/local/)

## Host privately on Tailscale

Use a host that stays awake while the team is meeting. Each joining device needs a route to the host through the tailnet, a browser, and the guild invite. The following example uses two available Tailscale Serve HTTPS ports, one for the guild and one for LiveKit signaling.

1. Install Node.js, Tailscale and LiveKit Server on the host. On macOS, Homebrew provides `livekit`. Run `npm ci --prefix collaboration`.
2. Generate a LiveKit API key and secret with `livekit-server generate-keys`. Put them in a mode-600 LiveKit config file outside the checkout. In this example, replace `TAILNET_IPV4` with the address from `tailscale ip -4` in both places. The media listener accepts UDP on that address.

   ```yaml
   port: 7880
   bind_addresses: ["127.0.0.1"]
   rtc:
     node_ip: TAILNET_IPV4
     use_external_ip: false
     udp_port: 7882
     tcp_port: 0
     ips:
       includes: ["TAILNET_IPV4/32"]
   keys:
     GENERATED_API_KEY: GENERATED_API_SECRET
   ```

3. Start `livekit-server --config /path/to/livekit.yaml`. Create a separate mode-600 Node environment file outside the repo with the values below. Use the host's full MagicDNS name, the same LiveKit credentials, and an independent random invitation such as the output of `openssl rand -hex 32`. The optional roster path is the host's Herdr app home followed by `/shared.json`.

   ```dotenv
   RUNESPACE_ORIGIN=https://YOUR-HOST.YOUR-TAILNET.ts.net:8465
   RUNESPACE_INVITE=YOUR_RANDOM_GUILD_INVITE
   LIVEKIT_URL=wss://YOUR-HOST.YOUR-TAILNET.ts.net:8466
   LIVEKIT_API_KEY=GENERATED_API_KEY
   LIVEKIT_API_SECRET=GENERATED_API_SECRET
   # RUNESPACE_AGENT_ROSTER=/absolute/path/to/herdr-app/shared.json
   ```

4. Start the room and add the two tailnet routes. Choose unused HTTPS ports and use the same values in the environment file. Tailnet access rules must allow clients to reach those two TCP ports and the host's UDP port 7882 for media.

   ```sh
   node --env-file=/path/to/team.env collaboration/server.mjs
   # In another terminal:
   tailscale serve --bg --https=8465 http://127.0.0.1:8787
   tailscale serve --bg --https=8466 http://127.0.0.1:7880
   ```

5. Open the guild URL with `/#invite=YOUR_RANDOM_GUILD_INVITE` appended. Join by name and turn on **Mic** or **Camera** when you want to talk. An approaching teammate appears within six world units and drops out beyond eight. **Leave guild** disconnects the session and releases its devices. Rotating the invite and restarting the room service requires people to join again with the new link.

The app has room for 32 humans. Its optional agent roster shows local harness classes and work status using generated character names. Agent conversations, terminals, commands and working directories stay on the desktop. Walking and voice work independently, so people can join with both devices off.

To use another LiveKit deployment, set the three `LIVEKIT_*` values to its credentials and secure WebSocket endpoint. For your own public network deployment, plan for ICE and TURN in addition to HTTPS signaling. [LiveKit ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)

## Open the room from Herdr

Create `~/.config/herdr-app/data/runespace-team.json` (or the same path under `HERDR_APP_HOME`) with permissions `600`. Set its URL to the full invitation.

```json
{"url":"https://YOUR-HOST.YOUR-TAILNET.ts.net:8465/#invite=YOUR_RANDOM_GUILD_INVITE"}
```

Click **Team guild** in the RuneSpace header. It opens the browser world where your teammates are. The desktop's **Guild world** opens the personal game and agent conversations.
