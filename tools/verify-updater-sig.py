#!/usr/bin/env python3
"""Verify a KOVA updater signature the way Tauri/minisign does.

Tauri (rust-minisign) signs the BLAKE2b-512 PREHASH of the artifact,
not the raw bytes (SIGALG_PREHASHED = "ED"). The .sig file is base64 of
a 4-line minisign text; the manifest's `signature` field is that .sig
file content verbatim.

Usage:
  python3 verify-updater-sig.py <artifact> <artifact.sig> [pubkey-b64]
Default pubkey: the one in app/src-tauri/tauri.conf.json (key 17B9991EF35C5CBD).
Exit 0 = both the file signature and the global (trusted-comment)
signature verify. Also prints the trusted comment (file + version).
"""
import base64, hashlib, json, sys
from pathlib import Path

# --- minimal pure-python Ed25519 verify (RFC 8032) ---
_q = 2**255 - 19
_l = 2**252 + 27742317777372353535851937790883648493
_d = -121665 * pow(121666, _q - 2, _q) % _q
_I = pow(2, (_q - 1) // 4, _q)

def _xrecover(y):
    xx = (y * y - 1) * pow(_d * y * y + 1, _q - 2, _q) % _q
    x = pow(xx, (_q + 3) // 8, _q)
    if (x * x - xx) % _q != 0:
        x = x * _I % _q
    if x % 2 != 0:
        x = _q - x
    return x

def _decodepoint(s):
    y = int.from_bytes(s, 'little') & ((1 << 255) - 1)
    sign = (int.from_bytes(s, 'little') >> 255) & 1
    x = _xrecover(y)
    if x & 1 != sign:
        x = _q - x
    return (x, y)

def _edwards(P, Q):
    x1, y1 = P; x2, y2 = Q
    x3 = (x1 * y2 + x2 * y1) * pow(1 + _d * x1 * x2 * y1 * y2, _q - 2, _q) % _q
    y3 = (y1 * y2 + x1 * x2) * pow(1 - _d * x1 * x2 * y1 * y2, _q - 2, _q) % _q
    return (x3, y3)

def _scalarmult(P, e):
    Q = (0, 1)
    while e > 0:
        if e & 1:
            Q = _edwards(Q, P)
        P = _edwards(P, P); e >>= 1
    return Q

_By = 4 * pow(5, _q - 2, _q) % _q
_B = (_xrecover(_By), _By)

def checkvalid(sig, m, pk):
    if len(sig) != 64 or len(pk) != 32:
        return False
    R = _decodepoint(sig[:32]); A = _decodepoint(pk)
    S = int.from_bytes(sig[32:], 'little')
    if S >= _l:
        return False
    h = int.from_bytes(hashlib.sha512(sig[:32] + pk + m).digest(), 'little') % _l
    return _scalarmult(_B, S) == _edwards(R, _scalarmult(A, h))

def main():
    artifact, sigfile = sys.argv[1], sys.argv[2]
    if len(sys.argv) > 3:
        pub_b64 = sys.argv[3]
    else:
        conf = json.load(open(Path(__file__).resolve().parent.parent
                              / 'app/src-tauri/tauri.conf.json'))
        pub_b64 = conf['plugins']['updater']['pubkey']
    pub_blob = base64.b64decode(base64.b64decode(pub_b64).split(b'\n')[1])
    keyid_pub = pub_blob[2:10][::-1].hex().upper()
    pk = pub_blob[10:42]
    inner = base64.b64decode(Path(sigfile).read_text().strip()).decode()
    lines = inner.splitlines()
    blob = base64.b64decode(lines[1])
    keyid_sig = blob[2:10][::-1].hex().upper()
    sig64 = blob[10:74]
    global64 = base64.b64decode(lines[3])
    trusted = lines[2].removeprefix('trusted comment: ')
    print('pubkey key id:', keyid_pub)
    print('sig key id:   ', keyid_sig, '| match:', keyid_sig == keyid_pub)
    print('trusted comment:', lines[2])
    data = Path(artifact).read_bytes()
    prehash = hashlib.blake2b(data, digest_size=64).digest()
    file_ok = checkvalid(sig64, prehash, pk)
    global_ok = checkvalid(global64, sig64 + trusted.encode(), pk)
    print('file signature valid:  ', file_ok)
    print('global signature valid:', global_ok)
    sys.exit(0 if (file_ok and global_ok and keyid_sig == keyid_pub) else 1)

if __name__ == '__main__':
    main()
