# ARES Browser Identity Proof

This is a read-only diagnostic probe for the real headed SeleniumBase Pure-CDP runtime.

It intentionally does **not** modify production fingerprint values and does not call BrowserLeaks.
Instead it runs the same ARES `SeleniumBaseCdpAdapter` twice with fresh profiles and evaluates three deterministic measurement seeds (`101`, `202`, `303`). The seed changes only the local measurement stimulus (Canvas, WebGL pixels, font metrics, and ClientRects geometry).

The proof checks:

- HTTP User-Agent vs `navigator.userAgent`
- HTTP `Accept-Language` vs `navigator.language`
- Client-Hints platform vs `navigator.userAgentData.platform` when exposed by Chrome on the local origin
- JavaScript/runtime feature surface
- Canvas, WebGL, font-metric, and ClientRects stability for the same seed across two browser restarts
- distinct measurement hashes for different seeds

The JSON artifact explicitly marks hosted-CI gaps such as public IP/DNS, TLS JA3/JA4, HTTP/2/3, WebRTC address leakage, and real-GPU parity. Those require a suitable external endpoint or a self-hosted runner and are not inferred from a GitHub-hosted VM.

No cookies, auth tokens, public IP addresses, or unrestricted request headers are written to the artifact.
