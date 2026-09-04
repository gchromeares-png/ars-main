import { mkdir } from "fs/promises";
import * as path from "path";
import { chromium } from "patchright";
import type { BrowserContext, Page } from "patchright";
import { BrowserLaunchError } from "./errors";
import { collectBrowserEnvironment, failedBrowserEnvironmentAudit } from "./browser-environment-audit";
import type { BrowserContextConfig, BrowserContextHandle, BrowserProxyConfig } from "./types";
import { installWebRtcProxyPolicy } from "./webrtc/webrtc-proxy-policy";
import { attachLiveChallengePageWatcher } from "../challenges/live-challenge-page-watcher";

const WEBRTC_PROXY_POLICY = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
const WEBRTC_PERMISSION_CHECK = "--enforce-webrtc-ip-permission-check";
const DISABLE_ASYNC_DNS = "--disable-async-dns";
const DISABLE_FEATURES_PREFIX = "--disable-features=";
const HOST_RESOLVER_RULES_PREFIX = "--host-resolver-rules=";
const PROXY_DISABLED_FEATURES = ["DnsOverHttps", "NetworkPrediction"] as const;

function assertTaskId(taskId: string): void {
  if (!taskId || !taskId.trim()) {
    throw new TypeError("taskId must not be empty.");
  }
}

function toProxy(proxy?: BrowserProxyConfig): {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
} | undefined {
  if (!proxy) return undefined;
  if (!proxy.host || !proxy.host.trim()) {
    throw new TypeError("Proxy host must not be empty.");
  }
  if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
    throw new RangeError(`Invalid proxy port: ${proxy.port}`);
  }

  return {
    server: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
    username: proxy.username || undefined,
    password: proxy.password || undefined,
    bypass: proxy.bypass || undefined
  };
}

function mergeDisabledFeatures(args: string[], required: readonly string[]): string[] {
  const passthrough: string[] = [];
  const disabled: string[] = [];

  for (const arg of args) {
    if (!arg.startsWith(DISABLE_FEATURES_PREFIX)) {
      passthrough.push(arg);
      continue;
    }

    disabled.push(...arg.slice(DISABLE_FEATURES_PREFIX.length).split(",").map(value => value.trim()).filter(Boolean));
  }

  for (const feature of required) {
    if (!disabled.includes(feature)) disabled.push(feature);
  }

  passthrough.push(`${DISABLE_FEATURES_PREFIX}${disabled.join(",")}`);
  return passthrough;
}

function strictHostResolverRule(proxy: BrowserProxyConfig): string | undefined {
  // Explicit proxy bypass rules intentionally permit direct traffic. In that case
  // do not install a global DNS black-hole rule because it would break the bypass.
  if (proxy.bypass?.trim()) return undefined;
  return `${HOST_RESOLVER_RULES_PREFIX}MAP * ~NOTFOUND , EXCLUDE ${proxy.host.trim()}`;
}

function buildChromiumArgs(config: BrowserContextConfig): string[] | undefined {
  const args = [...(config.args ?? [])];
  if (!config.proxy) return args.length ? args : undefined;

  // Keep WebRTC enabled while forbidding a parallel direct UDP path outside the proxy.
  let hardened = args.filter(arg =>
    !arg.startsWith("--force-webrtc-ip-handling-policy=") && arg !== "--enable-async-dns"
  );
  if (!hardened.includes(WEBRTC_PERMISSION_CHECK)) hardened.push(WEBRTC_PERMISSION_CHECK);
  hardened.push(WEBRTC_PROXY_POLICY);

  // Modern Chromium replaced the old dns-prefetch switch with NetworkPrediction.
  // Disable speculative network prediction, Secure DNS/DoH and the built-in async
  // DNS client for explicit proxy sessions.
  hardened = mergeDisabledFeatures(hardened, PROXY_DISABLED_FEATURES);
  if (!hardened.includes(DISABLE_ASYNC_DNS)) hardened.push(DISABLE_ASYNC_DNS);

  // With no explicit bypass, block every local hostname resolution except the
  // proxy endpoint itself. HTTP(S) proxies receive destination hostnames directly;
  // Chromium SOCKS5 always performs destination name resolution proxy-side.
  const resolverRule = strictHostResolverRule(config.proxy);
  if (resolverRule) {
    hardened = hardened.filter(arg => !arg.startsWith(HOST_RESOLVER_RULES_PREFIX));
    hardened.push(resolverRule);
  }

  return hardened;
}

async function initialPage(context: BrowserContext): Promise<Page> {
  const pages = context.pages();
  return pages[0] ?? context.newPage();
}

export async function launchBrowserContext(config: BrowserContextConfig): Promise<BrowserContextHandle> {
  assertTaskId(config.taskId);
  await mkdir(config.userDataDir, { recursive: true });

  // Never unlink Chromium Singleton* files blindly. Chromium owns stale-profile
  // recovery; deleting a live lock can allow two persistent contexts to touch
  // the same cookie/history SQLite files after an unclean worker shutdown.

  let context: BrowserContext | undefined;
  const launchOptions = {
    headless: config.headless ?? false,
    proxy: toProxy(config.proxy),
    userAgent: config.userAgent || undefined,
    locale: config.locale,
    timezoneId: config.timezoneId,
    viewport: config.viewport === undefined ? null : config.viewport,
    args: buildChromiumArgs(config)
  };

  try {
    try {
      context = await chromium.launchPersistentContext(config.userDataDir, {
        channel: "chrome",
        ...launchOptions
      });
    } catch (channelError) {
      // Fallback to default chromium if Google Chrome channel executable is missing
      context = await chromium.launchPersistentContext(config.userDataDir, launchOptions);
    }

    context.setDefaultTimeout(config.actionTimeoutMs ?? 15_000);
    context.setDefaultNavigationTimeout(config.navigationTimeoutMs ?? 30_000);

    // Proxy sessions keep RTCPeerConnection alive. Before any shop script runs,
    // hide page-visible local/private ICE candidates; transport routing remains
    // Chromium-owned and is separately constrained by disable_non_proxied_udp.
    if (config.proxy) await installWebRtcProxyPolicy(context);

    const page = await initialPage(context);
    const environmentAudit = await collectBrowserEnvironment(page).catch(error => failedBrowserEnvironmentAudit(error));

    // Existing challenge watcher remains unchanged.
    attachLiveChallengePageWatcher(page);

    return {
      taskId: config.taskId,
      context,
      page,
      createdAt: new Date(),
      userDataDir: config.userDataDir,
      environmentAudit
    };
  } catch (error) {
    if (context) {
      await context.close().catch(() => undefined);
    }
    throw new BrowserLaunchError(config.taskId, error);
  }
}
