import type { BrowserContext } from "../types";

/**
 * Page-visible WebRTC privacy layer for proxied browser sessions.
 *
 * Chromium still owns the real transport. This script does not fabricate ICE
 * addresses and does not disable RTCPeerConnection. It prevents page scripts
 * from observing local/private host candidates while Chromium's
 * disable_non_proxied_udp policy blocks a parallel direct UDP path.
 */
export const WEBRTC_PROXY_INIT_SCRIPT = String.raw`(() => {
  const NativeRTCPeerConnection = window.RTCPeerConnection;
  if (!NativeRTCPeerConnection || window.__aresWebRtcProxyPolicyInstalled) return;

  Object.defineProperty(window, "__aresWebRtcProxyPolicyInstalled", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  const PRIVATE_V4 = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
  const PRIVATE_V6 = /^(?:::1$|fe80:|fc|fd)/i;

  const candidateAddress = candidate => {
    if (!candidate) return "";
    if (typeof candidate.address === "string" && candidate.address) return candidate.address;
    const raw = String(candidate.candidate || "").trim();
    const parts = raw.split(/\s+/);
    return parts.length > 4 ? parts[4] : "";
  };

  const candidateType = candidate => {
    if (!candidate) return "";
    if (typeof candidate.type === "string" && candidate.type) return candidate.type.toLowerCase();
    const raw = String(candidate.candidate || "");
    const match = raw.match(/\btyp\s+([a-z0-9-]+)/i);
    return match ? match[1].toLowerCase() : "";
  };

  const isPrivateAddress = address => {
    const value = String(address || "").toLowerCase();
    if (!value) return false;
    if (value.endsWith(".local")) return true;
    return PRIVATE_V4.test(value) || PRIVATE_V6.test(value);
  };

  const isVisibleCandidate = candidate => {
    if (!candidate) return true;
    const type = candidateType(candidate);
    const address = candidateAddress(candidate);
    if (type === "host") return false;
    if (isPrivateAddress(address)) return false;
    return true;
  };

  const scrubSdp = sdp => String(sdp || "")
    .split(/\r?\n/)
    .filter(line => {
      if (!/^a=candidate:/i.test(line)) return true;
      const raw = line.replace(/^a=/i, "");
      return isVisibleCandidate({ candidate: raw });
    })
    .join("\r\n");

  const sanitizedDescription = description => {
    if (!description) return description;
    return Object.freeze({ type: description.type, sdp: scrubSdp(description.sdp) });
  };

  class AresRTCPeerConnection extends NativeRTCPeerConnection {
    constructor(configuration) {
      super(configuration);
      this.__aresIceListeners = new Map();
      this.__aresOnIceCandidate = null;

      super.addEventListener("icecandidate", event => {
        if (!isVisibleCandidate(event.candidate)) {
          event.stopImmediatePropagation();
        }
      }, true);
    }

    addEventListener(type, listener, options) {
      if (type !== "icecandidate" || !listener) {
        return super.addEventListener(type, listener, options);
      }

      const wrapped = event => {
        if (!isVisibleCandidate(event.candidate)) return;
        if (typeof listener === "function") listener.call(this, event);
        else if (listener && typeof listener.handleEvent === "function") listener.handleEvent(event);
      };
      this.__aresIceListeners.set(listener, wrapped);
      return super.addEventListener(type, wrapped, options);
    }

    removeEventListener(type, listener, options) {
      if (type === "icecandidate" && listener && this.__aresIceListeners.has(listener)) {
        const wrapped = this.__aresIceListeners.get(listener);
        this.__aresIceListeners.delete(listener);
        return super.removeEventListener(type, wrapped, options);
      }
      return super.removeEventListener(type, listener, options);
    }

    set onicecandidate(listener) {
      this.__aresOnIceCandidate = listener;
      super.onicecandidate = listener
        ? event => {
            if (isVisibleCandidate(event.candidate)) listener.call(this, event);
          }
        : null;
    }

    get onicecandidate() {
      return this.__aresOnIceCandidate;
    }

    get localDescription() {
      return sanitizedDescription(super.localDescription);
    }

    get currentLocalDescription() {
      return sanitizedDescription(super.currentLocalDescription);
    }

    get pendingLocalDescription() {
      return sanitizedDescription(super.pendingLocalDescription);
    }
  }

  Object.defineProperty(AresRTCPeerConnection, "name", { value: "RTCPeerConnection" });
  Object.setPrototypeOf(AresRTCPeerConnection, NativeRTCPeerConnection);
  window.RTCPeerConnection = AresRTCPeerConnection;
})();`;

export async function installWebRtcProxyPolicy(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: WEBRTC_PROXY_INIT_SCRIPT });
}
