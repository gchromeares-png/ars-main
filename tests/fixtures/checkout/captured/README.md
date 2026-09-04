# Captured checkout DOM fixtures

Captured fixtures are static, sanitized DOM references from real checkout pages. They are not live-shop code and must not contain credentials, session state, personal profile data, or executable/network content.

## Required intake flow

1. Capture the rendered checkout DOM at the desired stage.
2. Run it through `sanitizeCapturedDom()` before it is written into the repository.
3. Pass known personal values from the capture session through `redactValues` so names, street/address fragments, phone numbers, cities, postal codes, and other user-entered values are replaced even when they appear outside form values.
4. Review the sanitized output manually for remaining personal data and secrets.
5. Commit only the sanitized HTML plus a fixture manifest with:
   - `source: "captured-dom"`
   - `capture.sanitized: true`
   - `capture.sanitizerVersion: 1`
   - a non-sensitive `sourceLabel`
   - capture timestamp
6. The fixture loader runs `assertSanitizedCapturedDom()` and rejects obvious unsanitized captures.

## Never commit

- cookies or storage dumps
- authorization headers
- CSRF/session/auth tokens
- checkout URLs containing query tokens
- hidden token fields
- real names, email addresses, phone numbers, street addresses, postal codes, or other profile values
- payment data
- scripts copied from the live checkout

For multi-step checkouts, store each sanitized rendered DOM state as its own stage in the same manifest. The fixture runner can replay each stage independently through Planner -> Resolver -> AutoFill -> Completion -> Observability.
