//! Which address to rate-limit when Plim sits behind a reverse proxy or a
//! Cloudflare Tunnel. A client IP header is only believed when the connection
//! itself comes from a trusted proxy address or range.

use std::net::IpAddr;

use axum::http::HeaderMap;

/// An IP address range in CIDR notation (`10.89.0.0/16`, `::1/128`); a bare
/// address means a single host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IpNet {
    addr: IpAddr,
    prefix: u8,
}

impl IpNet {
    pub fn parse(s: &str) -> Option<Self> {
        let (addr, prefix) = match s.split_once('/') {
            Some((a, p)) => (a.trim().parse::<IpAddr>().ok()?, Some(p.trim().parse::<u8>().ok()?)),
            None => (s.trim().parse::<IpAddr>().ok()?, None),
        };
        let addr = addr.to_canonical();
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(max);
        (prefix <= max).then_some(IpNet { addr, prefix })
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip.to_canonical()) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => {
                let mask = u32::MAX.checked_shl(32 - self.prefix as u32).unwrap_or(0);
                u32::from(net) & mask == u32::from(ip) & mask
            }
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                let mask = u128::MAX.checked_shl(128 - self.prefix as u32).unwrap_or(0);
                u128::from(net) & mask == u128::from(ip) & mask
            }
            _ => false,
        }
    }
}

impl std::fmt::Display for IpNet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.addr, self.prefix)
    }
}

/// Where a trusted proxy puts the real client address.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ClientIpHeader {
    /// The rightmost `X-Forwarded-For` entry (the one the proxy appended).
    #[default]
    XForwardedFor,
    /// Cloudflare's `CF-Connecting-IP`, which its edge always overwrites.
    CfConnectingIp,
}

impl ClientIpHeader {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "x-forwarded-for" => Some(Self::XForwardedFor),
            "cf-connecting-ip" => Some(Self::CfConnectingIp),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::XForwardedFor => "x-forwarded-for",
            Self::CfConnectingIp => "cf-connecting-ip",
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ProxyConfig {
    pub trusted: Vec<IpNet>,
    pub header: ClientIpHeader,
}

impl ProxyConfig {
    /// From `PLIM_TRUSTED_PROXIES` (comma-separated addresses or CIDR ranges)
    /// and `PLIM_CLIENT_IP_HEADER`. Invalid entries are reported and skipped.
    pub fn from_env_values(trusted: &str, header: Option<&str>) -> Self {
        let trusted = trusted
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .filter_map(|s| {
                let net = IpNet::parse(s);
                if net.is_none() {
                    eprintln!("PLIM_TRUSTED_PROXIES: ignoring {s:?} (not an IP address or CIDR range)");
                }
                net
            })
            .collect();
        let header = match header.filter(|h| !h.trim().is_empty()) {
            None => ClientIpHeader::default(),
            Some(h) => ClientIpHeader::parse(h).unwrap_or_else(|| {
                eprintln!("PLIM_CLIENT_IP_HEADER: unknown {h:?}; use x-forwarded-for or cf-connecting-ip");
                ClientIpHeader::default()
            }),
        };
        ProxyConfig { trusted, header }
    }

    pub fn is_trusted(&self, peer: IpAddr) -> bool {
        self.trusted.iter().any(|n| n.contains(peer))
    }

    pub fn describe(&self) -> String {
        if self.trusted.is_empty() {
            return "none (rate limits use the connecting address)".into();
        }
        let list: Vec<String> = self.trusted.iter().map(IpNet::to_string).collect();
        format!("{} via {}", list.join(", "), self.header.name())
    }
}

/// Whether the request carries any client IP header a proxy would add.
pub fn has_forwarding_header(headers: &HeaderMap) -> bool {
    headers.contains_key("x-forwarded-for") || headers.contains_key("cf-connecting-ip")
}

/// The address to rate-limit. Client headers are only believed from a trusted
/// peer; otherwise (or if the header is missing or malformed) the peer is used.
pub fn client_ip(peer: IpAddr, headers: &HeaderMap, cfg: &ProxyConfig) -> IpAddr {
    let peer = peer.to_canonical();
    if !cfg.is_trusted(peer) {
        return peer;
    }
    let claimed = match cfg.header {
        ClientIpHeader::XForwardedFor => headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .last()
            .map(str::to_string),
        ClientIpHeader::CfConnectingIp => {
            headers.get("cf-connecting-ip").and_then(|v| v.to_str().ok()).map(str::to_string)
        }
    };
    claimed.and_then(|s| s.trim().parse::<IpAddr>().ok()).map(|ip| ip.to_canonical()).unwrap_or(peer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.append(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
        }
        m
    }

    #[test]
    fn cidr_ranges() {
        let n = IpNet::parse("10.89.42.0/24").unwrap();
        assert!(n.contains(ip("10.89.42.1")) && n.contains(ip("10.89.42.255")));
        assert!(!n.contains(ip("10.89.43.1")));
        // IPv4-mapped IPv6 peers (dual-stack sockets) match IPv4 ranges.
        assert!(n.contains(ip("::ffff:10.89.42.7")));
        assert!(IpNet::parse("0.0.0.0/0").unwrap().contains(ip("203.0.113.9")));
        assert!(IpNet::parse("127.0.0.1").unwrap().contains(ip("127.0.0.1")));
        assert!(!IpNet::parse("127.0.0.1").unwrap().contains(ip("127.0.0.2")));
        let v6 = IpNet::parse("fd00::/8").unwrap();
        assert!(v6.contains(ip("fd12::1")) && !v6.contains(ip("fe80::1")));
        assert!(!v6.contains(ip("10.0.0.1")));
        for bad in ["10.0.0.0/33", "::/129", "nope", "10.0.0.0/x", ""] {
            assert!(IpNet::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn config_parsing() {
        let c = ProxyConfig::from_env_values(" 10.89.42.0/24, 127.0.0.1 , bogus", Some("CF-Connecting-IP"));
        assert_eq!(c.trusted.len(), 2);
        assert_eq!(c.header, ClientIpHeader::CfConnectingIp);
        assert_eq!(c.describe(), "10.89.42.0/24, 127.0.0.1/32 via cf-connecting-ip");
        assert_eq!(ProxyConfig::from_env_values("", Some("nonsense")).header, ClientIpHeader::XForwardedFor);
        assert!(ProxyConfig::from_env_values("", None).describe().starts_with("none"));
    }

    #[test]
    fn forwarded_for_from_trusted_range_rightmost_entry() {
        let cfg = ProxyConfig::from_env_values("10.89.42.0/24", None);
        let proxy = ip("10.89.42.3");
        let client = ip("203.0.113.7");
        let spoof = "1.2.3.4";
        assert_eq!(client_ip(client, &headers(&[("x-forwarded-for", spoof)]), &cfg), client);
        assert_eq!(client_ip(proxy, &headers(&[("x-forwarded-for", &format!("{spoof}, {client}"))]), &cfg), client);
        assert_eq!(client_ip(proxy, &headers(&[("x-forwarded-for", spoof), ("x-forwarded-for", "203.0.113.7")]), &cfg), client);
        assert_eq!(client_ip(proxy, &headers(&[]), &cfg), proxy);
        assert_eq!(client_ip(proxy, &headers(&[("x-forwarded-for", "garbage")]), &cfg), proxy);
        // CF-Connecting-IP is ignored in x-forwarded-for mode.
        assert_eq!(client_ip(proxy, &headers(&[("cf-connecting-ip", spoof)]), &cfg), proxy);
    }

    #[test]
    fn cf_connecting_ip_only_from_trusted_peers() {
        let cfg = ProxyConfig::from_env_values("10.89.42.0/24", Some("cf-connecting-ip"));
        let tunnel = ip("10.89.42.3");
        let client = ip("2001:db8::7");
        let h = headers(&[("cf-connecting-ip", "2001:db8::7"), ("x-forwarded-for", "9.9.9.9")]);
        assert_eq!(client_ip(tunnel, &h, &cfg), client);
        // The same header from anywhere else is a spoofing attempt.
        assert_eq!(client_ip(ip("203.0.113.50"), &h, &cfg), ip("203.0.113.50"));
        // Mapped peers are normalised before matching.
        assert_eq!(client_ip(ip("::ffff:10.89.42.3"), &h, &cfg), client);
        assert_eq!(client_ip(tunnel, &headers(&[]), &cfg), tunnel);
        // Nothing is trusted by default.
        assert_eq!(client_ip(tunnel, &h, &ProxyConfig::default()), tunnel);
    }
}
