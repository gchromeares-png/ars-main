import { IncapsulaWaitingRoom, parseWaitingRoomTime } from "../src/browser-worker/incapsula-waiting-room";
import type { WaitingRoomDetection } from "../src/browser-worker/incapsula-waiting-room";

function locator(text: string | undefined, count = 0) {
  const value = {
    first: () => value,
    count: async () => count,
    textContent: async () => text ?? null
  };
  return value;
}

function fakeFrame(url: string, ttw?: string, body = "") {
  return {
    url: () => url,
    locator: (selector: string) => selector === "#ttw" ? locator(ttw) : locator(body)
  };
}

function fakePage(options: {
  url?: string;
  iframeCount?: number;
  mainTtw?: string;
  frames?: any[];
  cookies?: Array<{ name: string }>;
}) {
  return {
    isClosed: () => false,
    url: () => options.url ?? "https://example.test/",
    locator: (selector: string) => {
      if (selector === "#ttw") return locator(options.mainTtw);
      if (selector.includes("_Incapsula_Resource")) return locator(undefined, options.iframeCount ?? 0);
      return locator(undefined);
    },
    frames: () => options.frames ?? [],
    context: () => ({ cookies: async () => options.cookies ?? [] })
  } as any;
}

describe("IncapsulaWaitingRoom", () => {
  it("parses HH:MM:SS queue estimates", () => {
    expect(parseWaitingRoomTime("00:12:08")).toBe(728);
    expect(parseWaitingRoomTime("1:00:00")).toBe(3600);
    expect(parseWaitingRoomTime("00:60:00")).toBeUndefined();
    expect(parseWaitingRoomTime("12 minutes")).toBeUndefined();
  });

  it("detects the Pokemon Center style Incapsula queue from frame + #ttw", async () => {
    const waitingRoom = new IncapsulaWaitingRoom();
    const page = fakePage({
      iframeCount: 1,
      frames: [fakeFrame("https://example.test/_Incapsula_Resource?queue=1", "00:12:08", "Estimated wait time")],
      cookies: [{ name: "incap_ses_123_456" }]
    });

    const result = await waitingRoom.detect(page);

    expect(result.inQueue).toBe(true);
    expect(result.provider).toBe("incapsula");
    expect(result.estimatedWaitSeconds).toBe(728);
    expect(result.evidence).toEqual(expect.arrayContaining([
      "incapsula-iframe",
      "incapsula-frame-url",
      "frame-ttw",
      "incap-session-cookie"
    ]));
  });

  it("does not confuse ordinary Imperva presence with a waiting room", async () => {
    const waitingRoom = new IncapsulaWaitingRoom();
    const page = fakePage({
      iframeCount: 1,
      frames: [fakeFrame("https://example.test/_Incapsula_Resource?sensor=1", undefined, "Security resource")],
      cookies: [{ name: "incap_ses_123_456" }]
    });

    const result = await waitingRoom.detect(page);

    expect(result.inQueue).toBe(false);
    expect(result.provider).toBeUndefined();
    expect(result.evidence).toEqual(expect.arrayContaining([
      "incapsula-iframe",
      "incapsula-frame-url",
      "incap-session-cookie"
    ]));
  });

  it("waits until the queue disappears and reports waiting then released", async () => {
    const sequence: WaitingRoomDetection[] = [
      { inQueue: true, provider: "incapsula", estimatedWaitSeconds: 2, evidence: ["ttw"] },
      { inQueue: true, provider: "incapsula", estimatedWaitSeconds: 1, evidence: ["ttw"] },
      { inQueue: false, evidence: [] }
    ];

    class SequenceWaitingRoom extends IncapsulaWaitingRoom {
      private index = 0;
      async detect(): Promise<WaitingRoomDetection> {
        const value = sequence[Math.min(this.index, sequence.length - 1)];
        this.index += 1;
        return value;
      }
    }

    const statuses: string[] = [];
    const page = { isClosed: () => false } as any;
    const result = await new SequenceWaitingRoom().waitIfNeeded(page, {
      pollIntervalMs: 250,
      statusIntervalMs: 250,
      maxWaitMs: 5_000,
      onStatus: status => statuses.push(status.state)
    });

    expect(result.waited).toBe(true);
    expect(result.state).toBe("released");
    expect(statuses[0]).toBe("waiting");
    expect(statuses[statuses.length - 1]).toBe("released");
  });
});
