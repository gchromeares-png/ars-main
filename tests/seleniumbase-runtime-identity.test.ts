import * as fs from "fs";
import * as path from "path";

describe("SeleniumBase runtime identity", () => {
  const identity = fs.readFileSync(
    path.resolve(__dirname, "../python/seleniumbase_cdp/runtime_identity.py"),
    "utf8"
  );
  const adapter = fs.readFileSync(
    path.resolve(__dirname, "../python/seleniumbase_cdp/seleniumbase_adapter.py"),
    "utf8"
  );

  it("assigns an ARES-owned UUID before Chromium starts", () => {
    expect(identity).toContain('RUNTIME_ENV = "ARES_BROWSER_SESSION_ID"');
    expect(identity).toContain('RUNTIME_ARG_PREFIX = "--ares-session-id="');
    expect(identity).toContain("uuid.uuid4().hex");
    expect(adapter).toContain("BrowserRuntimeIdentity.create(self.profile_dir)");
    expect(adapter.indexOf("BrowserRuntimeIdentity.create(self.profile_dir)"))
      .toBeLessThan(adapter.indexOf("sb_cdp.Chrome(**kwargs)"));
  });

  it("keeps an atomic profile-side runtime record for startup diagnostics", () => {
    expect(identity).toContain('RUNTIME_FILENAME = ".ares-browser-runtime.json"');
    expect(identity).toContain('"state": "starting"');
    expect(identity).toContain('"state": "ready"');
    expect(identity).toContain('"workerPid"');
    expect(identity).toContain('"browserPid"');
    expect(identity).toContain('"cdpPort"');
    expect(identity).toContain("temporary.replace(target)");
  });

  it("resolves the exact Chromium process family by runtime identity", () => {
    expect(identity).toContain("process.environ()");
    expect(identity).toContain("self.marker_arg in command_line");
    expect(adapter).toContain("self._runtime_identity.browser_pids()");
    expect(adapter).toContain("runtime_matches");
  });

  it("observes SeleniumBase's actual CDP port instead of forcing a shared fixed port", () => {
    expect(identity).toContain("get_rd_port");
    expect(identity).toContain('DEBUG_PORT_PREFIX = "--remote-debugging-port="');
    expect(identity).not.toContain("--remote-debugging-port=9222");
    expect(adapter).not.toContain("--remote-debugging-port=9222");
  });

  it("removes only its own runtime sidecar on clean shutdown", () => {
    expect(identity).toContain('raw.get("runtimeSessionId")');
    expect(adapter).toContain("self._runtime_identity.clear()");
  });
});
