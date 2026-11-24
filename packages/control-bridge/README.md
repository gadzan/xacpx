# @ganglion/xacpx-control-bridge

Shared mapping between xacpx's `PublicControlService` and the relay wire protocol. The relay hub and the relay channel plugin both use it, so a new control call is added once.

It also holds the in-memory transcript (`MemoryMessageStore`) and the compact history projection. Those have no dependency on xacpx itself.
