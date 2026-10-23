# @ganglion/xacpx-relay-protocol

Shared wire protocol for the xacpx relay hub: the JSON envelope exchanged over
WebSocket between xacpx instances, the relay server, and the web frontend, plus
the wire DTOs that mirror the core Control API surface.

Pure types + codecs. No runtime dependencies; does not depend on xacpx.

Conversation prompt RPCs, including the policy variant, accept `media?: PromptAttachmentRef[]`.
Requests may contain attachments with empty text. The shared validator limits a request
to five attachments and each attachment to the upload limit of 10 MiB. Accepted refs
are stored with the durable request message and reused after restart. Replaying the
same request ID with changed text or media fails with `request_payload_conflict`.
Conversation message DTOs expose `attachments?: AttachmentMetadata[]`, which omits
daemon file paths and only includes bounded image data URL previews.


See `docs/superpowers/specs/2026-06-13-relay-hub-design.md` in the repo root for
the overall design.
