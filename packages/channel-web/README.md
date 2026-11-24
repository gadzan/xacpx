# @ganglion/xacpx-channel-web

A local web console for one xacpx daemon. It serves the shared dashboard on this machine and talks to the daemon directly, so a relay hub is not required.

```bash
xacpx channel add web
xacpx channel add web --port 7890 --host 127.0.0.1
xacpx channel add web --host 192.168.1.20 --port 7890 --token <secret>
```

The default address is `127.0.0.1:7890`. A non-loopback address is refused unless `--token` is set, and it must be the address the browser opens, not `0.0.0.0`. The local terminal is on unless you pass `--no-terminal`. It reuses the relay channel's terminal module, not a relay connection. Running a relay dashboard at the same time keeps a second terminal process. A permission card is attached to the chat key until core includes the session. Remote desktop viewing is not part of this version.
