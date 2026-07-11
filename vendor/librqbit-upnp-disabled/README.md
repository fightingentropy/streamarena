# Disabled librqbit UPnP shim

StreamArena starts `librqbit` with `enable_upnp_port_forwarding: false`. This
private compatibility crate supplies the API that librqbit 8.x links against
without including an unused SSDP/SOAP client or XML parser in the production
dependency graph.

If StreamArena ever enables UPnP, remove this patch and upgrade to an upstream
`librqbit-upnp` release whose `quick-xml` dependency includes the current
security fixes.
