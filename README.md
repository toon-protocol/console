# The TOON Console

The console for [TOON Network](https://github.com/toon-protocol/TOON_Network): a local
daemon plus a web UI, opened as an Omarchy web app. It is not a website — a
`systemd --user` service runs `@toon-protocol/client`, serves the UI on `127.0.0.1`, and
holds the account's keys, so nothing about an account lives on a server anyone else
operates ([ADR 0019](https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0019-the-console-is-a-local-app-not-a-website.md)).

Built under [Milestone 8](https://github.com/toon-protocol/TOON_Network/issues/84).
