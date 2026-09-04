import { mkdir } from "fs/promises";
import * as path from "path";
import { chromium } from "patchright";
import type { BrowserContext, Page } from "patchright";
import { BrowserLaunchError } from "./errors";
import type { BrowserContextConfig, BrowserContextHandle, BrowserProxyConfig } from "./types";
import { attachLiveChallengePageWatcher } from "../challenges/live-challenge-page-watcher";

const WEBRTC_PROXY_POLICY = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
const WEBRTC_PERMISSION_CHECK = "--enforce-webrtc-ip-permission-check";

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

function buildChromiumArgs(config: BrowserContextConfig): string[] | undefined {
  const args = [...(config.args ?? [])];
  if (!config.proxy) return args.length ? args : undefined;

  // A proxied browser must not open a parallel non-proxied WebRTC UDP route.
  const hardened = args.filter(arg => !arg.startsWith("--force-webrtc-ip-handling-policy="));
  if (!hardened.includes(WEBRTC_PERMISSION_CHECK)) {
    hardened.push(WEBRTC_PERMISSION_CHECK);
  }
  hardened.push(WEBRTC_PROXY_POLICY);
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

    const page = await initialPage(context);

    // 🚀 Hier wird der globale Watcher an die Page gehängt:
    attachLiveChallengePageWatcher(page);

    return {
      taskId: config.taskId,
      context,
      page,
      createdAt: new Date(),
      userDataDir: config.userDataDir
    };
  } catch (error) {
    if (context) {
      await context.close().catch(() => undefined);
    }
    throw new BrowserLaunchError(config.taskId, error);
  }
}
