//! Join codes: the host's IPv4 address, port and session secret in 18 typeable characters
//! (Crockford base32, `XXXXXX-XXXXXX-XXXXXX`), so a guest needs nothing else to connect.

use std::net::{IpAddr, Ipv4Addr, UdpSocket};

/// Crockford's alphabet: no I, L, O or U, which are read back as 1, 1, 0 and nothing.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const SECRET_LEN: usize = 5;
const CODE_BYTES: usize = 4 + 2 + SECRET_LEN;
const CODE_CHARS: usize = (CODE_BYTES * 8).div_ceil(5);
const GROUP: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JoinCode {
    pub ip: Ipv4Addr,
    pub port: u16,
    pub secret: [u8; SECRET_LEN],
}

impl JoinCode {
    pub fn encode(&self) -> String {
        let mut bytes = [0u8; 16];
        bytes[16 - CODE_BYTES..16 - CODE_BYTES + 4].copy_from_slice(&self.ip.octets());
        bytes[16 - CODE_BYTES + 4..16 - SECRET_LEN].copy_from_slice(&self.port.to_be_bytes());
        bytes[16 - SECRET_LEN..].copy_from_slice(&self.secret);
        let value = u128::from_be_bytes(bytes);
        let mut out = String::with_capacity(CODE_CHARS + CODE_CHARS / GROUP);
        for i in 0..CODE_CHARS {
            if i > 0 && i % GROUP == 0 {
                out.push('-');
            }
            let shift = 5 * (CODE_CHARS - 1 - i);
            out.push(ALPHABET[((value >> shift) & 31) as usize] as char);
        }
        out
    }

    /// Accepts any case, dashes and spaces, and the letters Crockford reads as digits.
    pub fn parse(code: &str) -> Option<Self> {
        let mut value: u128 = 0;
        let mut count = 0;
        for c in code.chars() {
            if c == '-' || c.is_whitespace() {
                continue;
            }
            let c = match c.to_ascii_uppercase() {
                'I' | 'L' => '1',
                'O' => '0',
                c => c,
            };
            let digit = ALPHABET.iter().position(|&a| a as char == c)?;
            value = (value << 5) | digit as u128;
            count += 1;
            if count > CODE_CHARS {
                return None;
            }
        }
        if count != CODE_CHARS || value >> (CODE_BYTES * 8) != 0 {
            return None;
        }
        let bytes = value.to_be_bytes();
        let start = 16 - CODE_BYTES;
        let ip = Ipv4Addr::new(bytes[start], bytes[start + 1], bytes[start + 2], bytes[start + 3]);
        let port = u16::from_be_bytes([bytes[start + 4], bytes[start + 5]]);
        let mut secret = [0u8; SECRET_LEN];
        secret.copy_from_slice(&bytes[16 - SECRET_LEN..]);
        Some(Self { ip, port, secret })
    }
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the OS random generator is available");
    bytes
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compares secrets without stopping at the first difference.
pub fn same_secret(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The address other machines on the network reach this one at: the source address of the
/// default route. Connecting a UDP socket sends no packet. Loopback when there is no network.
pub fn lan_ipv4() -> Ipv4Addr {
    let routed = |target: &str| {
        let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
        socket.connect(target).ok()?;
        match socket.local_addr().ok()?.ip() {
            IpAddr::V4(ip) if !ip.is_unspecified() => Some(ip),
            _ => None,
        }
    };
    routed("8.8.8.8:80").or_else(|| routed("192.168.255.255:9")).unwrap_or(Ipv4Addr::LOCALHOST)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_tolerates_typing() {
        let code = JoinCode { ip: Ipv4Addr::new(192, 168, 1, 37), port: 1440, secret: [0, 255, 7, 128, 42] };
        let text = code.encode();
        // `src/collab/invite.test.ts` decodes this same code.
        assert_eq!(text, "60N00J-A1D003-ZGF01A");
        assert_eq!(JoinCode::parse(&text), Some(code));
        let typed = text.to_lowercase().replace('-', " ").replace('0', "o").replace('1', "l");
        assert_eq!(JoinCode::parse(&typed), Some(code));
    }

    #[test]
    fn rejects_malformed_codes() {
        let text = JoinCode { ip: Ipv4Addr::LOCALHOST, port: 9, secret: [1; SECRET_LEN] }.encode();
        assert!(JoinCode::parse(&text[..text.len() - 1]).is_none());
        assert!(JoinCode::parse(&format!("{text}0")).is_none());
        assert!(JoinCode::parse(&text.replace(&text[0..1], "U")).is_none());
        assert!(JoinCode::parse("ZZZZZZ-ZZZZZZ-ZZZZZZ").is_none());
    }

    #[test]
    fn compares_secrets() {
        assert!(same_secret(b"abc", b"abc"));
        assert!(!same_secret(b"abc", b"abd"));
        assert!(!same_secret(b"abc", b"ab"));
    }
}
