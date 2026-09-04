import * as fs from "fs";
import * as path from "path";

describe("Profile V2 UI wiring", () => {
  const component = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.ts"), "utf8");
  const html = fs.readFileSync(path.resolve(__dirname, "../src/app/app.component.html"), "utf8");
  const profileV2 = fs.readFileSync(path.resolve(__dirname, "../src/profiles/profile-v2.ts"), "utf8");

  it("normalizes persisted legacy profiles into the V2 editor", () => {
    expect(component).toContain("toProfileV2Draft(profile)");
    expect(component).toContain("toPersistedAresProfile(profile)");
    expect(profileV2).toContain("cloneAddress(profile.shippingAddress, profile.address)");
    expect(profileV2).toContain("address: { ...shippingAddress }");
  });

  it("renders separate shipping and billing address controls", () => {
    expect(html).toContain('[(ngModel)]="newProfile.shippingAddress.city"');
    expect(html).toContain('[(ngModel)]="newProfile.billingSameAsShipping"');
    expect(html).toContain('*ngIf="!newProfile.billingSameAsShipping"');
    expect(html).toContain('[(ngModel)]="newProfile.billingAddress.city"');
    expect(html).toContain('[(ngModel)]="newProfile.shippingAddress.street"');
    expect(html).toContain('[(ngModel)]="newProfile.shippingAddress.houseNumber"');
    expect(html).toContain('[(ngModel)]="newProfile.billingAddress.street"');
    expect(html).toContain('[(ngModel)]="newProfile.billingAddress.houseNumber"');
    expect(html).not.toContain("newProfile.address.");
  });

  it("exposes a simple KI AutoFill switch backed by the profile browser preference", () => {
    expect(html).toContain('[(ngModel)]="newProfile.browser!.kiAutofill"');
    expect(html).toContain("KI AutoFill");
    expect(profileV2).toContain("kiAutofill: profile.browser?.kiAutofill !== false");
  });
});
