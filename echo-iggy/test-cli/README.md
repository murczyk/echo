# Iggy test CLI

This directory contains a dependency-free Python CLI for testing an Apache
Iggy server through its HTTP API.

The checks verify that:

- the server accepts the configured credentials and responds to requests;
- the configured stream and inbox/analytics topics exist;
- a unique test event can be published to and read back from each topic.

## Configuration

Create the local environment file:

```sh
cp .env.example .env
```

Fill in `.env` with the target server's HTTP URL, credentials, stream, and
topic names. `IGGY_HTTP_URL` must point to Iggy's HTTP listener, usually port
`3000`, rather than its TCP listener.

The `.env` file is ignored by Git. `.env.example` documents every supported
setting.

## Usage

Run all checks:

```sh
just test-all
```

Run individual checks:

```sh
just check
just test-inbox
just test-analytics
```

The publish checks add one small JSON test event to their target topic and
print both the sent and received payloads.

## Topic commands

Send a random JSON test event to any existing topic:

```sh
just send test-inbox-01
```

Print messages not previously read by this CLI's consumer for a topic:

```sh
just print-new test-inbox-01
```

`print-new` keeps a stable Iggy consumer ID for each stream/topic pair and
commits its offset. The first run may print existing topic messages; later
runs print only messages after the last committed offset. JSON and UTF-8
payloads are decoded for display, while binary payloads are printed as base64.
