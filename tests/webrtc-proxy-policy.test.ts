import * as fs from "fs";
import * as path from "path";

describe("proxied WebRTC proxy-follow policy", () => {
  const launcher = fs.readFileSync(
    path.resolve(__dirname, "../src/browser-worker/patchright-launcher.ts"),
    "utf8"
  );
  const audit = fs.readFileSync(
    path.resolve(__dirname, "../src/browser-worker/browser-environment-audit.ts"),
    "utf8"
  );

  it("keeps WebRTC enabled while preventing a parallel direct UDP path", () => {
    expect(launcher).toContain('const WEBRTC_PROXY_POLICY = "disable_non_proxied_udp"');
    expect(launcher).toContain('const FORCE_WEBRTC_IP_HANDLING_POLICY_PREFIX = "--force-webrtc-ip-handling-policy="');
    expect(launcher).toContain('const WEBRTC_IP_HANDLING_POLICY_PREFIX = "--webrtc-ip-handling-policy="');
    expect(launcher).toContain('const WEBRTC_PERMISSION_CHECK = "--enforce-webrtc-ip-permission-check"');
    expect(launcher).not.toContain('"--disable-webrtc"');
  });

  it("uses Chromium's documented headless/headed policy switch variants", () => {
    expect(launcher).toContain('config.headless === true');
    expect(launcher).toContain('`${FORCE_WEBRTC_IP_HANDLING_POLICY_PREFIX}${WEBRTC_PROXY_POLICY}`');
    expect(launcher).toContain('`${WEBRTC_IP_HANDLING_POLICY_PREFIX}${WEBRTC_PROXY_POLICY}`');
  });

  it("keeps navigator.mediaDevices and RTCPeerConnection observable instead of disabling them", () => {
    expect(audit).toContain('mediaDevicesAvailable: Boolean(navigator.mediaDevices)');
    expect(audit).toContain('peerConnectionAvailable: typeof RTCPeerConnection === "function"');
  });

  it("keeps proxy DNS hardening alongside WebRTC proxy-follow behavior", () => {
    expect(launcher).toContain('const DISABLE_ASYNC_DNS = "--disable-async-dns"');
    expect(launcher).toContain('const PROXY_DISABLED_FEATURES = ["DnsOverHttps", "NetworkPrediction"]');
    expect(launcher).toContain("strictHostResolverRule(config.proxy)");
  });
});
