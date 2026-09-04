import * as fs from "fs";
import * as path from "path";

describe("WebRTC proxy consistency policy", () => {
  const policy = fs.readFileSync(
    path.resolve(__dirname, "../src/browser-worker/webrtc/webrtc-proxy-policy.ts"),
    "utf8"
  );
  const launcher = fs.readFileSync(
    path.resolve(__dirname, "../src/browser-worker/patchright-launcher.ts"),
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
    expect(launcher).toContain('import { installWebRtcProxyPolicy } from "./webrtc/webrtc-proxy-policy"');
    expect(launcher).toContain("if (config.proxy) await installWebRtcProxyPolicy(context)");
  });

  it("retains Chromium transport-level non-proxied UDP protection", () => {
    expect(launcher).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(launcher).toContain("--enforce-webrtc-ip-permission-check");
  });

  it("does not touch the challenge implementation", () => {
    expect(launcher).toContain("attachLiveChallengePageWatcher(page)");
  });
});
