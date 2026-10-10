#!/usr/bin/env python3
"""Generate an Android signing identity in a private directory, never in git."""
import argparse
import base64
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
location = args.output.resolve()
location.mkdir(parents=True, exist_ok=True)
keystore = location / "radar-mobile-signing.p12"
password_file = location / "signing-password.txt"
b64_file = location / "signing-keystore-base64.txt"
fingerprint_file = location / "signing-sha256.txt"

if any(item.exists() for item in (keystore, password_file, b64_file, fingerprint_file)):
    raise SystemExit("A signing identity already exists here; refusing to overwrite it.")

private_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Radar 2.0 Mobile")])
now = datetime.now(timezone.utc)
certificate = (
    x509.CertificateBuilder()
    .subject_name(name)
    .issuer_name(name)
    .public_key(private_key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - timedelta(days=1))
    .not_valid_after(now + timedelta(days=365 * 24))
    .sign(private_key, hashes.SHA256())
)
password = secrets.token_urlsafe(30)
blob = pkcs12.serialize_key_and_certificates(
    name=b"radarmobile",
    key=private_key,
    cert=certificate,
    cas=None,
    encryption_algorithm=serialization.BestAvailableEncryption(password.encode()),
)
keystore.write_bytes(blob)
password_file.write_text(password, encoding="utf8")
b64_file.write_text(base64.b64encode(blob).decode("ascii"), encoding="ascii")
fingerprint = certificate.fingerprint(hashes.SHA256()).hex().upper()
colon_fingerprint = ":".join(fingerprint[i:i+2] for i in range(0,len(fingerprint),2))
fingerprint_file.write_text(colon_fingerprint, encoding="ascii")
for item in (keystore, password_file, b64_file):
    try: item.chmod(0o600)
    except OSError: pass
try: location.chmod(0o700)
except OSError: pass
print("Signing identity created locally. Keep this directory private and backed up.")
print("Certificate SHA-256: " + colon_fingerprint)
print("Private key and password never printed.")
