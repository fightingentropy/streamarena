use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use reqwest::dns::{Addrs, Name, Resolve, Resolving};

/// Apply the provider-only transport policy. Redirects are intentionally
/// surfaced to the adapter instead of followed: every new destination must be
/// parsed and authorized before another request is made.
pub fn hardened_provider_client_builder(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(PublicDnsResolver)
}

/// Only compiled provider control-plane origins may use the operator's outbound
/// proxy. Provider-returned playlist/CDN hosts and admin-added providers stay on
/// direct, DNS-pinned egress so a remote proxy cannot become an SSRF relay.
pub fn provider_proxy_is_allowed_host(host: &str) -> bool {
    const TRUSTED_HOSTS: &[&str] = &[
        "enc-dec.app",
        "gallic.aether.bar",
        "meridian.aether.bar",
        "streams.icefy.top",
        "snowhouse.lordflix.club",
        "addon-osvh.onrender.com",
        "player.videasy.net",
        "player.videasy.to",
        "vidlink.pro",
        "vidrock.net",
        "vixsrc.to",
    ];
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    TRUSTED_HOSTS.contains(&host.as_str())
}

#[derive(Clone, Copy)]
struct PublicDnsResolver;

impl Resolve for PublicDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let hostname = name.as_str().to_owned();
        Box::pin(async move {
            let resolved = tokio::net::lookup_host((hostname.as_str(), 0))
                .await
                .map_err(boxed_io_error)?
                .collect::<Vec<_>>();
            validate_public_dns_answer(&hostname, &resolved)?;
            Ok(Box::new(resolved.into_iter()) as Addrs)
        })
    }
}

fn boxed_io_error(error: io::Error) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(error)
}

fn validate_public_dns_answer(
    hostname: &str,
    addresses: &[SocketAddr],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(Box::new(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("provider DNS answer for {hostname} contained a non-public address"),
        )));
    }
    Ok(())
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !matches!(
        (a, b, c),
        (0, _, _)
            | (10, _, _)
            | (100, 64..=127, _)
            | (127, _, _)
            | (169, 254, _)
            | (172, 16..=31, _)
            | (192, 0, 0)
            | (192, 0, 2)
            | (192, 168, _)
            | (198, 18..=19, _)
            | (198, 51, 100)
            | (203, 0, 113)
            | (224..=255, _, _)
    )
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(embedded) = address.to_ipv4() {
        return is_public_ipv4(embedded);
    }
    let segments = address.segments();
    !address.is_unspecified()
        && !address.is_loopback()
        && !address.is_multicast()
        && !address.is_unique_local()
        && !address.is_unicast_link_local()
        && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
        && !(segments[0] == 0x2001 && segments[1] == 0x0002)
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::{
        hardened_provider_client_builder, is_public_ip, provider_proxy_is_allowed_host,
        validate_public_dns_answer,
    };

    #[test]
    fn rejects_private_reserved_and_mapped_addresses() {
        for address in [
            "127.0.0.1",
            "10.0.0.7",
            "100.64.0.1",
            "169.254.1.2",
            "172.16.0.1",
            "192.168.1.1",
            "198.18.0.1",
            "203.0.113.8",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::127.0.0.1",
        ] {
            assert!(
                !is_public_ip(address.parse().expect("test IP")),
                "{address}"
            );
        }
        for address in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(is_public_ip(address.parse().expect("test IP")), "{address}");
        }
    }

    #[test]
    fn rejects_mixed_dns_answers_instead_of_filtering_the_private_half() {
        let answers = [
            "1.1.1.1:443".parse::<SocketAddr>().expect("public"),
            "127.0.0.1:443".parse::<SocketAddr>().expect("private"),
        ];
        assert!(validate_public_dns_answer("rebind.example", &answers).is_err());
    }

    #[test]
    fn outbound_proxy_is_limited_to_compiled_provider_origins() {
        assert!(provider_proxy_is_allowed_host("vixsrc.to"));
        assert!(provider_proxy_is_allowed_host("streams.icefy.top"));
        assert!(!provider_proxy_is_allowed_host("evilvixsrc.to"));
        assert!(!provider_proxy_is_allowed_host("returned-cdn.example"));
        assert!(!provider_proxy_is_allowed_host("custom-addon.example"));
    }

    #[tokio::test]
    async fn provider_transport_does_not_follow_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("connection");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await.expect("read request");
            socket
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("write response");
        });
        let client = hardened_provider_client_builder(reqwest::Client::builder())
            .build()
            .expect("provider client");
        let response = client
            .get(format!("http://{address}/redirect"))
            .send()
            .await
            .expect("redirect response");
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        server.await.expect("server task");
    }
}
