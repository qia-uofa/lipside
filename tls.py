"""TLS certificate generation and inspection helpers."""
import ipaddress, socket
from pathlib import Path


def _collect_san_entries() -> tuple[set[str], set]:
    """Return (dns_names, ip_addresses) covering loopback + this machine."""
    dns_names: set[str] = {"localhost"}
    ip_addrs: set = {
        ipaddress.IPv4Address("127.0.0.1"),
        ipaddress.IPv6Address("::1"),
    }
    try:
        hostname = socket.gethostname()
        if hostname:
            dns_names.add(hostname)
            try:
                ip_addrs.add(ipaddress.ip_address(socket.gethostbyname(hostname)))
            except Exception:
                pass
    except Exception:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ip_addrs.add(ipaddress.ip_address(s.getsockname()[0]))
    except Exception:
        pass
    return dns_names, ip_addrs


def _cert_fingerprint(cert_pem: bytes) -> str:
    """Return a human-readable SHA-256 fingerprint of a PEM certificate."""
    import hashlib
    from cryptography import x509 as _x509
    from cryptography.hazmat.primitives.serialization import Encoding
    der = _x509.load_pem_x509_certificate(cert_pem).public_bytes(Encoding.DER)
    h = hashlib.sha256(der).hexdigest().upper()
    return ":".join(h[i:i+2] for i in range(0, len(h), 2))


def _print_cert_info(cert_path: Path) -> None:
    """Print fingerprint and SAN entries for the active certificate."""
    from cryptography import x509 as _x509
    try:
        pem = cert_path.read_bytes()
        fp = _cert_fingerprint(pem)
        cert = _x509.load_pem_x509_certificate(pem)
        try:
            san = cert.extensions.get_extension_for_class(_x509.SubjectAlternativeName)
            dns  = san.value.get_values_for_type(_x509.DNSName)
            ips  = [str(a) for a in san.value.get_values_for_type(_x509.IPAddress)]
            print(f"[LIPSIDE] TLS cert SANs: DNS={dns} IPs={ips}")
        except Exception:
            pass
        print(f"[LIPSIDE] TLS cert SHA-256 fingerprint:")
        print(f"[LIPSIDE]   {fp}")
        print(f"[LIPSIDE] Verify this fingerprint in your browser's cert viewer to confirm")
        print(f"[LIPSIDE] the connection is not being intercepted.")
    except Exception:
        pass


def _ensure_tls_cert() -> tuple[Path, Path]:
    """Return (cert_path, key_path), generating a self-signed cert if missing.

    The cert lives in ~/.lipside/ and is reused across all workspaces.  It
    includes the machine's hostname and primary outbound IP in the SAN so
    remote browsers don't hit a hostname-mismatch error.

    The cert is valid for 10 years.  To force regeneration (e.g. after the
    machine's IP changes), delete ~/.lipside/lipside.crt and lipside.key and
    restart LIPSIDE, or use --cert / --key to supply your own certificate.
    """
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    import datetime

    tls_dir = Path.home() / ".lipside"
    tls_dir.mkdir(parents=True, exist_ok=True)
    cert_path = tls_dir / "lipside.crt"
    key_path  = tls_dir / "lipside.key"

    if cert_path.exists() and key_path.exists():
        return cert_path, key_path

    print("[LIPSIDE] Generating self-signed TLS certificate …")

    dns_names, ip_addrs = _collect_san_entries()

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    key_path.chmod(0o600)

    san_entries: list = [x509.DNSName(n) for n in sorted(dns_names)]
    for addr in sorted(ip_addrs, key=str):
        san_entries.append(x509.IPAddress(addr))

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "LIPSIDE"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "LIPSIDE"),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.now(datetime.timezone.utc))
        .not_valid_after(
            datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(days=3650)
        )
        .add_extension(
            x509.SubjectAlternativeName(san_entries),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    print(f"[LIPSIDE] Certificate written to {cert_path}")
    print(f"[LIPSIDE] SANs: DNS={sorted(dns_names)}  IPs={sorted(ip_addrs, key=str)}")
    print(f"[LIPSIDE] To permanently dismiss the browser warning, import {cert_path}")
    print(f"[LIPSIDE] into your OS/browser CA trust store.")
    print(f"[LIPSIDE] To regenerate (e.g. after an IP change): delete {cert_path}")
    return cert_path, key_path
