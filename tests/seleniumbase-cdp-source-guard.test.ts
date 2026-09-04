import * as fs from "fs";
import * as path from "path";

describe("SeleniumBase CDP PoC architecture guard", () => {
  const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "..", relative), "utf8");
  const requirements = read("requirements-seleniumbase-cdp.txt");
  const worker = read("python/seleniumbase_cdp/worker.py");
  const probe = read("python/seleniumbase_cdp/persistence_probe.py");

  it("uses pinned SeleniumBase pure CDP without classic Selenium WebDriver", () => {
    expect(requirements).toContain("seleniumbase==4.53.7");
    expect(worker).toContain("from seleniumbase import sb_cdp");
    expect(worker).toContain("sb_cdp.Chrome(");
    expect(worker).toContain("user_data_dir=str(profile_dir)");
    expect(worker).toContain("sb.quit()");
    expect(worker).not.toContain("selenium.webdriver");
  });

  it("keeps the SeleniumBase worker isolated from Patchright and ARES protected cores", () => {
    expect(worker.toLowerCase()).not.toContain("patchright");
    expect(worker).not.toContain("src/challenges");
    expect(worker).not.toContain("field-semantic-resolver");
    expect(worker).not.toContain("payment");
  });

  it("verifies persistence through two separate worker processes using one SeleniumBase profile", () => {
    expect(probe).toContain("subprocess.run(");
    expect(probe).toContain('action="seed-persistence"');
    expect(probe).toContain('action="read-persistence"');
    expect(probe).toContain("profile_dir=profile_dir");
    expect(probe).toContain("second Python process");
  });
});
