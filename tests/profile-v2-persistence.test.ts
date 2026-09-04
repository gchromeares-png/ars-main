import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ProfileRepository } from "../src/profiles/profile-repository";
import { toPersistedAresProfile, toProfileV2Draft } from "../src/profiles/profile-v2";
import type { AresProfile } from "../src/profiles/models";

describe("Profile V2 persistence", () => {
  it("loads a legacy address-only profile as shipping/default", () => {
    const legacy: AresProfile = {
      id: "legacy",
      name: "Legacy",
      contact: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" },
      address: {
        address1: "Musterstraße 1",
        postalCode: "20095",
        city: "Hamburg",
        countryCode: "DE"
      }
    };

    const draft = toProfileV2Draft(legacy);
    expect(draft.shippingAddress.city).toBe("Hamburg");
    expect(draft.shippingAddress.address1).toBe("Musterstraße 1");
    expect(draft.billingSameAsShipping).toBe(true);
  });

  it("persists structured street/house number without breaking address1 and reloads billing", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ares-profile-v2-"));
    const file = path.join(tempDir, "profiles.json");

    try {
      const draft = toProfileV2Draft();
      draft.id = "v2";
      draft.name = "V2";
      draft.contact = { firstName: "Max", lastName: "Mustermann", email: "max@example.test" };
      draft.shippingAddress = {
        address1: "",
        street: "Mönckebergstraße",
        houseNumber: "7",
        postalCode: "20095",
        city: "Hamburg",
        countryCode: "DE"
      };
      draft.billingSameAsShipping = false;
      draft.billingAddress = {
        address1: "Alexanderplatz 1",
        street: "Alexanderplatz",
        houseNumber: "1",
        postalCode: "10178",
        city: "Berlin",
        countryCode: "DE"
      };

      const firstRepository = new ProfileRepository(file);
      firstRepository.save(toPersistedAresProfile(draft));

      const reloaded = new ProfileRepository(file).get("v2");
      expect(reloaded).toBeDefined();
      expect(reloaded?.address.address1).toBe("Mönckebergstraße 7");
      expect(reloaded?.shippingAddress?.street).toBe("Mönckebergstraße");
      expect(reloaded?.shippingAddress?.houseNumber).toBe("7");
      expect(reloaded?.shippingAddress?.city).toBe("Hamburg");
      expect(reloaded?.billingAddress?.city).toBe("Berlin");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("omits explicit billing when same-as-shipping is selected", () => {
    const draft = toProfileV2Draft();
    draft.id = "same";
    draft.name = "Same";
    draft.contact = { firstName: "Mia", lastName: "Muster", email: "mia@example.test" };
    draft.shippingAddress = {
      address1: "Testweg 2",
      postalCode: "20095",
      city: "Hamburg",
      countryCode: "DE"
    };
    draft.billingAddress = {
      address1: "Andere Straße 9",
      postalCode: "10115",
      city: "Berlin",
      countryCode: "DE"
    };
    draft.billingSameAsShipping = true;

    const persisted = toPersistedAresProfile(draft);
    expect(persisted.shippingAddress?.city).toBe("Hamburg");
    expect(persisted.billingAddress).toBeUndefined();
  });
});
