import * as fs from "fs";
import * as path from "path";

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");

describe("SeleniumBase interaction hardening", () => {
  const grid = read("python/seleniumbase_cdp/site_grid_adapter.py");
  const gridActions = read("python/seleniumbase_cdp/authorized_grid_action_executor.py");
  const slider = read("python/seleniumbase_cdp/site_slider_adapter.py");
  const sliderActions = read("python/seleniumbase_cdp/slider_action_executor.py");

  it("recognizes broader visual grid shapes and image representations", () => {
    expect(grid).toContain("6: (2, 3)");
    expect(grid).toContain("12: (3, 4)");
    expect(grid).toContain("25: (5, 5)");
    expect(grid).toContain("querySelectorAll?.('img,canvas')");
    expect(grid).toContain("backgroundImage");
    expect(grid).toContain("toDataURL?.('image/png')");
    expect(gridActions).toContain("[4, 6, 8, 9, 12, 16, 20, 25]");
  });

  it("uses SeleniumBase native drag when a stable selector is available", () => {
    expect(slider).toContain("handleSelector");
    expect(slider).toContain("trackSelector");
    expect(sliderActions).toContain("get_gui_element_center");
    expect(sliderActions).toContain("gui_drag_drop_points");
    expect(sliderActions).toContain("timeframe=0.55");
    expect(sliderActions).toContain('mode = "seleniumbase-native"');
  });

  it("keeps grid and slider execution on SeleniumBase-owned action paths", () => {
    expect(sliderActions).toContain('mode = "seleniumbase-native"');
    expect(gridActions).toContain("class AuthorizedGridActionExecutor");
    expect(gridActions).toContain("selected = self._indexes(");
    expect(gridActions).toContain("return self._apply_state(state, selected, submit=submit)");
    expect(gridActions).toContain('getattr(images[index], "mouse_click"');
    expect(gridActions).not.toContain("pyautogui");
  });
});
