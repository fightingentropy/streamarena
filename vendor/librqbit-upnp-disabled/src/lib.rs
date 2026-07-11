//! Compatibility surface for librqbit when UPnP is intentionally disabled.
//!
//! `LocalTorrentService` always sets `enable_upnp_port_forwarding` to `false`,
//! so librqbit never calls this shim. Keeping the small API it compiles against
//! avoids shipping the unused network discovery and XML parsing implementation.

use std::time::Duration;

/// Options retained for source compatibility with librqbit 8.x.
pub struct UpnpPortForwarderOptions {
    pub lease_duration: Duration,
    pub discover_interval: Duration,
    pub discover_timeout: Duration,
}

impl Default for UpnpPortForwarderOptions {
    fn default() -> Self {
        Self {
            discover_interval: Duration::from_secs(60),
            discover_timeout: Duration::from_secs(10),
            lease_duration: Duration::from_secs(60),
        }
    }
}

/// A disabled port forwarder retained only to satisfy librqbit's linkage.
pub struct UpnpPortForwarder;

impl UpnpPortForwarder {
    pub fn new(ports: Vec<u16>, _opts: Option<UpnpPortForwarderOptions>) -> anyhow::Result<Self> {
        anyhow::ensure!(!ports.is_empty(), "empty ports");
        anyhow::bail!("UPnP port forwarding is disabled in this StreamArena build")
    }

    pub async fn run_forever(self) -> ! {
        std::future::pending().await
    }
}
