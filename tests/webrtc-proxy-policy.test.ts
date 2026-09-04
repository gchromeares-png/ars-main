import * as fs from "fs";
import * as path from "path";

describe("proxied WebRTC proxy-follow policy", () => {
  const launcher = fs.readFileSync(
    path.resolve(__dirname, "../src/browser-worker/patchright-launcher.ts"),
    "utf8"
  );

  it("keeps WebRTC enabled and forces non-direct transport for proxied sessions", () => {
    expect(launcher).toContain('const FORCE_WEBRTC_IP_HANDLING_POLICY = "--force-webrtc-ip-handling-policy"');
    expect(launcher).toContain('const WEBRTC_IP_HANDLING_POLICY = "--webrtc-ip-handling-policy=disable_non_proxied_udp"');
    expect(launcher).toContain('const WEBRTC_PERMISSION_CHECK = "--enforce-webrtc-ip-permission-check"');
    expect(launcher).toContain("hardened.push(FORCE_WEBRTC_IP_HANDLING_POLICY, WEBRTC_IP_HANDLING_POLICY)");
    expect(launcher).not.toContain('"--disable-webrtc"');
    expect(launcher).not.toContain("WebRTC disabled");
  });

  it("removes caller-supplied WebRTC policy variants before applying the canonical proxy-follow policy", () => {
    expect(launcher).toContain('!arg.startsWith("--force-webrtc-ip-handling-policy=")');
    expect(launcher).toContain('!arg.startsWith("--webrtc-ip-handling-policy=")');
  });

  it("keeps proxy DNS hardening alongside WebRTC proxy-follow behavior", () => {
    expect(launcher).toContain('const DISABLE_ASYNC_DNS = "--disable-async-dns"');
    expect(launcher).toContain('const PROXY_DISABLED_FEATURES = ["DnsOverHttps", "NetworkPrediction"]');
    expect(launcher).toContain("strictHostResolverRule(config.proxy)");
  });
});
