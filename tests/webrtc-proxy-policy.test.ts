import * as fs from "fs";
import * as path from "path";

describe("WebRTC proxy consistency policy", () => {
  const policy = fs.readFileSync(
    path.resolve(__dirname, "../src/browser-worker/webrtc/webrtc-proxy-policy.ts"),
    "utf8"
  );
  const worker = fs.readFileSync(
    path.resolve(__dirname, "../src/browser-worker/seleniumbase-browser-worker.ts"),
    "utf8"
  );

  it("keeps WebRTC enabled and filters page-visible local/private ICE candidates", () => {
    expect(policy).toContain("RTCPeerConnection");
    expect(policy).toContain("icecandidate");
    expect(policy).toContain("localDescription");
    expect(policy).toContain('type === "host"');
    expect(policy).toContain("isPrivateAddress");
  });

  it("does not fabricate or replace ICE addresses", () => {
    expect(policy).not.toContain("proxyIp");
    expect(policy).not.toContain("replaceCandidateAddress");
    expect(policy).toContain("does not fabricate ICE");
  });

  it("installs the init script only for explicit proxy sessions", () => {
    expect(worker).toContain('import { installWebRtcProxyPolicy } from "./webrtc/webrtc-proxy-policy"');
    expect(worker).toContain("if (config.proxy) await installWebRtcProxyPolicy(context)");
  });

  it("retains Chromium transport-level non-proxied UDP protection", () => {
    expect(worker).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(worker).toContain("--enforce-webrtc-ip-permission-check");
    expect(worker).toContain("--disable-async-dns");
    expect(worker).toContain("DnsOverHttps,NetworkPrediction");
  });
});
