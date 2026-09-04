import * as fs from "fs";
import * as path from "path";

describe("runtime bulk controls and manual profile browser", () => {
  const runtimeTs = fs.readFileSync(
    path.resolve(__dirname, "../src/app/runtime-control/runtime-control.component.ts"),
    "utf8"
  );
  const runtimeHtml = fs.readFileSync(
    path.resolve(__dirname, "../src/app/runtime-control/runtime-control.component.html"),
    "utf8"
  );
  const preload = fs.readFileSync(path.resolve(__dirname, "../src/electron/preload.ts"), "utf8");
  const main = fs.readFileSync(path.resolve(__dirname, "../src/electron/main.ts"), "utf8");

  it("exposes one-click start and stop for all eligible tasks", () => {
    expect(runtimeTs).toContain("startAllTasks()");
    expect(runtimeTs).toContain("stopAllTasks()");
    expect(runtimeTs).toContain("this.electron.startTask(task.id)");
    expect(runtimeTs).toContain("this.electron.stopTask(task.id)");
    expect(runtimeHtml).toContain("ALLE STARTEN");
    expect(runtimeHtml).toContain("ALLE STOPPEN");
  });

  it("exposes manual open and close controls for persistent profile browsers", () => {
    expect(runtimeTs).toContain("openProfileBrowser(profile");
    expect(runtimeTs).toContain("closeProfileBrowser(profile");
    expect(runtimeHtml).toContain("BROWSER ÖFFNEN");
    expect(runtimeHtml).toContain("BROWSER SCHLIESSEN");
    expect(preload).toContain("open-profile-browser");
    expect(preload).toContain("close-profile-browser");
    expect(main).toContain('ipcMain.handle("open-profile-browser"');
    expect(main).toContain('ipcMain.handle("close-profile-browser"');
  });
});