import { assertSanitizedCapturedDom, sanitizeCapturedDom } from "./sanitize-captured-dom";

describe("captured checkout DOM sanitization", () => {
  it("removes executable, network, token and profile-value material while preserving form structure", () => {
    const raw = `<!doctype html><html><head>
      <meta name="csrf-token" content="secret">
      <script>window.__SESSION__ = "eyJaaaaaaaaaaa.bbbbbbbbbbb.ccccccccccc";</script>
    </head><body>
      <form action="https://checkout.example.test/submit?token=secret">
        <input type="hidden" name="csrf" value="secret-token">
        <input name="email" value="max@example.test" data-session-token="abc123">
        <input name="city" value="Hamburg">
        <textarea name="notes">Private note</textarea>
        <a href="https://checkout.example.test/account?id=123">Account</a>
      </form>
    </body></html>`;

    const sanitized = sanitizeCapturedDom(raw, {
      redactValues: ["Hamburg", "Private note"]
    });

    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("type=\"hidden\"");
    expect(sanitized).not.toContain("max@example.test");
    expect(sanitized).not.toContain("Hamburg");
    expect(sanitized).not.toContain("Private note");
    expect(sanitized).not.toContain("data-session-token");
    expect(sanitized).not.toContain("https://checkout.example.test");
    expect(sanitized).toContain('name="email"');
    expect(sanitized).toContain('name="city"');
    expect(() => assertSanitizedCapturedDom(sanitized)).not.toThrow();
  });

  it("rejects obviously unsanitized captured DOM", () => {
    expect(() => assertSanitizedCapturedDom('<input name="email" value="person@example.test">'))
      .toThrow(/not sanitized/i);
    expect(() => assertSanitizedCapturedDom('<script>const token = "secret"</script>'))
      .toThrow(/not sanitized/i);
  });
});
