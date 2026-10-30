# Remote access over Tailscale

[Back to the README](../README.md)

Spawnpoint serves plain HTTP on port 25570, on every network interface.
That is fine at home. To reach it from your phone on mobile data, or from a
friend's house, put the machine on a private network instead of forwarding
25570 on your router. [Tailscale](https://tailscale.com) is the setup this
page describes.

## 1. Join both devices to your tailnet

- On the machine that runs Spawnpoint, install Tailscale and sign in. On
  Linux:

  ```bash
  curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up
  ```

  On macOS and Windows, use the Tailscale app.
- On your phone, install the Tailscale app and sign in to the same account.

You can now open `http://<machine-name>:25570` on the phone (with MagicDNS)
or use the machine's `100.x.y.z` address from `tailscale ip -4`. Traffic
between your devices is encrypted by Tailscale, but the browser still sees
plain HTTP.

## 2. Add HTTPS with `tailscale serve` (recommended)

`tailscale serve` gives the panel an HTTPS address that only devices in your
tailnet can reach. Browsers treat that as a secure site, which some features
need, such as installing a site as an app.

1. In the Tailscale admin console, open **DNS** and make sure MagicDNS and
   HTTPS certificates are enabled.
2. On the Spawnpoint machine, run this (drop `sudo` on macOS and Windows):

   ```bash
   sudo tailscale serve --bg 25570
   ```

   It prints an address like `https://<machine-name>.<tailnet>.ts.net`.
3. Open that address on your phone and unlock with your PIN.

`tailscale serve status` shows the current setup. To stop serving the
panel, run `sudo tailscale serve --https=443 off`. `tailscale serve reset`
also works, but it clears every Serve setting on that machine.

`tailscale serve` passes the original `Host` header to the panel, which the
panel's same-origin check for browser writes relies on. If you put another
reverse proxy in front, make it preserve `Host` too.

## Don't use Funnel

`tailscale funnel` publishes a port to the whole internet. Use `serve`,
which keeps the panel inside your tailnet.
