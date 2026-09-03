import { mkdir, rm } from "fs/promises";
import * as path from "path";
import { chromium } from "patchright";
import type { BrowserContext, Page } from "patchright";
import { BrowserLaunchError } from "./errors";
import type { BrowserContextConfig, BrowserContextHandle, BrowserProxyConfig } from "./types";
import { attachLiveChallengePageWatcher } from "../challenges/live-challenge-page-watcher";

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

async function initialPage(context: BrowserContext): Promise<Page> {
  const pages = context.pages();
  return pages[0] ?? context.newPage();
}

async function clearStaleChromeLocks(userDataDir: string): Promise<void> {
  const staleLockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  await Promise.all(
    staleLockFiles.map(name =>
      rm(path.join(userDataDir, name), { force: true }).catch(() => undefined)
    )
  );
}

export async function launchBrowserContext(config: BrowserContextConfig): Promise<BrowserContextHandle> {
  assertTaskId(config.taskId);
  await mkdir(config.userDataDir, { recursive: true });
  await clearStaleChromeLocks(config.userDataDir);

  let context: BrowserContext | undefined;
  const launchOptions = {
    headless: config.headless ?? false,
    proxy: toProxy(config.proxy),
    userAgent: config.userAgent || undefined,
    locale: config.locale,
    timezoneId: config.timezoneId,
    viewport: config.viewport === undefined ? null : config.viewport,
    args: config.args ? [...config.args] : undefined
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