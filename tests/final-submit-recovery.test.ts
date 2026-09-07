import { confirmFinalSubmitWithRetries } from "../src/browser-worker/final-submit-recovery";

describe("confirmFinalSubmitWithRetries", () => {
  it("performs at least two confirmation attempts before giving up", async () => {
    const check = jest.fn().mockResolvedValue(false);
    const result = await confirmFinalSubmitWithRetries(check, { attempts: 1, delayMs: 0 });

    expect(result).toEqual({ confirmed: false, attempts: 2, maxAttempts: 2 });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("stops early when the second recovery observation confirms success", async () => {
    const check = jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const result = await confirmFinalSubmitWithRetries(check, { attempts: 2, delayMs: 0 });

    expect(result).toEqual({ confirmed: true, attempts: 2, maxAttempts: 2 });
    expect(check).toHaveBeenCalledTimes(2);
  });
});
