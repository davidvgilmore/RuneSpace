# Run the media backend on a dedicated Google VM

The Herdr host continues serving the guild, its invite link, avatar positions and agent roster. A separate LiveKit process on the VM forwards camera and microphone tracks. Team devices need tailnet access to both hosts. Signaling goes through Tailscale HTTPS on TCP 8466. WebRTC normally uses the VM’s Tailscale IPv4 on UDP 7882. If that path is unavailable, Herdr and browser clients can relay media over private TURN/TLS on TCP 443.

## Create and enroll the VM

This example uses a Debian 12 x86_64 VM without an attached service account or external IP. Use a subnet with outbound access through Cloud NAT or an equivalent egress route so the guest can reach Debian, Tailscale and GitHub. For SSH over IAP, use a project with IAP TCP forwarding, permission for your Google identity, and an ingress rule allowing the IAP proxy range to this VM’s TCP port 22. LiveKit needs no public GCP ingress rule. [Google’s IAP SSH guide](https://cloud.google.com/compute/docs/connect/ssh-using-iap)

Set the variables in your local shell to your project, zone and subnet. Creating the VM incurs Compute Engine charges.

```sh
PROJECT=your-project
ZONE=us-central1-a
SUBNET=your-subnet
VM=runespace-media

gcloud compute instances create "$VM" --project="$PROJECT" --zone="$ZONE" \
  --subnet="$SUBNET" --machine-type=e2-small --image-family=debian-12 \
  --image-project=debian-cloud --boot-disk-size=12GB --boot-disk-type=pd-balanced \
  --no-address --no-service-account --no-scopes
gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap
```

In the SSH session, install Tailscale and enroll this new node with the login URL printed by `tailscale up`. Choose the same tailnet as the guild host. Enable MagicDNS and Tailscale HTTPS certificates in its admin console if needed. Allow teammates to reach TCP 8466 for signaling, UDP 7882 for direct media, and TCP 443 for the TLS fallback on this VM. Port 443 must be available in the VM’s Tailscale Serve configuration. Use a Tailscale version whose Serve command supports PROXY protocol v2. [Install Tailscale on Debian](https://tailscale.com/download/linux) · [Tailscale HTTPS certificates](https://tailscale.com/kb/1153/enabling-https)

```sh
curl -fsSL https://tailscale.com/install.sh -o /tmp/install-tailscale.sh
sudo sh /tmp/install-tailscale.sh
sudo tailscale up --hostname=runespace-media
tailscale ip -4
```

## Install LiveKit

Back on your local computer, copy the installer and stream a private JSON object with exactly two fields, `key` and `secret`. Use the LiveKit key pair configured on the room service or generate a fresh pair and configure the same values there. Use a secret of at least 32 characters. Keep both values in a mode-600 file outside the checkout. The guild invitation stays on the Herdr host.

```sh
gcloud compute scp collaboration/deploy/install-media.py "$VM":install-media.py \
  --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap
gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap \
  --command='sudo -n python3 "$HOME/install-media.py" --credentials -' \
  -- -T < /private/path/to/media-keys.json
```

Alternatively, on the VM run `sudo python3 install-media.py --credentials /root/media-keys.json` with an owner-only input file. To pre-stage the release on a VM with restricted GitHub access, pass `--archive /path/to/livekit_1.13.11_linux_amd64.tar.gz`. The installer verifies the SHA-256 of the release and installs a systemd service with a dynamic user and a root-owned credential. Repeat runs with the same inputs preserve an active call. The installer checks local and tailnet signaling, the TURN certificate, and the actual listening sockets before printing the VM’s `wss://` endpoint. Upgrading an older UDP-only installation with the existing keys restarts LiveKit once. Run the upgrade between calls. [Pinned LiveKit release](https://github.com/livekit/livekit/releases/tag/v1.13.11)

Tailscale Serve terminates TURN TLS on TCP 443 and forwards it with PROXY protocol v2 to TCP 5349 on the VM’s own tailnet IPv4. LiveKit trusts PROXY headers from that single local address. Its authenticated TURN allocations bind UDP ports 40000–40999 on the same address and relay to the embedded SFU. Client tailnet access is needed only on the three client-facing ports above. Tailscale manages the TLS certificate. [LiveKit TURN deployment](https://docs.livekit.io/transport/self-hosting/deployment/) · [Tailscale Serve TCP forwarding](https://tailscale.com/docs/reference/tailscale-cli/serve)

## Switch the room service

On your Herdr host, set the room service’s persistent `LIVEKIT_URL` to the VM endpoint and set `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` to the same pair. Keep `RUNESPACE_ORIGIN` and `RUNESPACE_INVITE` unchanged. Apply the new settings when the current session can reconnect. Restarting the Node room service resets in-memory sessions. Team members can rejoin through their original guild invite.

Join from two tailnet devices and turn on mic and camera. Verify each receives the other’s tracks and that the selected remote ICE address is the VM’s Tailscale address. Once confirmed, retire the prior media service and its signaling proxy. The desktop’s guild web service stays running.

For a health check on the VM, run `sudo python3 install-media.py --check`. Inspect service status with `systemctl status runespace-media` and logs with `sudo journalctl -u runespace-media`.
