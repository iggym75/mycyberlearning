import test from "node:test";
import assert from "node:assert/strict";
import { commonsLicence, commonsNames, pickWikidataPerson } from "../pure.mjs";

const meta = (code, short, artist = "<a href=\"//commons.wikimedia.org/wiki/User:X\">Jane Doe</a>", url = "https://creativecommons.org/licenses/by-sa/4.0") =>
  ({ License: { value: code }, LicenseShortName: { value: short }, Artist: { value: artist }, LicenseUrl: { value: url } });

test("commonsLicence accepts PD, CC0, CC BY and CC BY-SA only", () => {
  assert.deepEqual(commonsLicence(meta("cc-by-sa-4.0", "CC BY-SA 4.0")), { licence: "CC BY-SA 4.0", licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0", author: "Jane Doe", shareAlike: true });
  assert.equal(commonsLicence(meta("cc-by-2.0", "CC BY 2.0")).shareAlike, false);
  assert.ok(commonsLicence(meta("cc0", "CC0", "")));
  assert.ok(commonsLicence(meta("pd", "Public domain", "")));
  assert.equal(commonsLicence(meta("cc-by-nc-sa-2.0", "CC BY-NC-SA 2.0")), null);
  assert.equal(commonsLicence(meta("cc-by-nd-4.0", "CC BY-ND 4.0")), null);
  assert.equal(commonsLicence(meta("cc-by-sa-4.0", "CC BY-SA 4.0", "")), null, "needs an author to credit");
  assert.equal(commonsLicence(meta("", "Fair use")), null);
  assert.equal(commonsLicence({}), null);
});

test("commonsNames cleans titles and keeps a real name in brackets", () => {
  assert.deepEqual(commonsNames("Dr Jessica Barker"), ["Jessica Barker"]);
  assert.deepEqual(commonsNames("Azeria (Maria Markstedter)"), ["Azeria", "Maria Markstedter"]);
  assert.deepEqual(commonsNames("Rob Fuller (mubix)"), ["Rob Fuller"]);
  assert.deepEqual(commonsNames("Prof. Alan Woodward"), ["Alan Woodward"]);
});

test("pickWikidataPerson needs a human with a photo, the same name and a matching link or role", () => {
  const ent = (id, label, desc, claims) => ({ id, labels: { en: { value: label } }, descriptions: { en: { value: desc } }, claims });
  const human = { mainsnak: { datavalue: { value: { id: "Q5" } } } }, img = f => [{ mainsnak: { datavalue: { value: f } } }];
  const e = {
    Q1: ent("Q1", "Bruce Schneier", "American footballer", { P31: [human], P18: img("Footballer.jpg") }),
    Q2: ent("Q2", "Bruce Schneier", "American cryptographer", { P31: [human], P18: img("Schneier.jpg") }),
    Q3: ent("Q3", "Bruce Schneier", "", { P31: [human], P18: img("Linked.jpg"), P856: [{ mainsnak: { datavalue: { value: "https://www.schneier.com/" } } }] }),
  };
  assert.equal(pickWikidataPerson(e, "Bruce Schneier", { web: "https://www.schneier.com/" }).file, "Linked.jpg");
  assert.equal(pickWikidataPerson({ Q1: e.Q1, Q2: e.Q2 }, "Bruce Schneier", {}).file, "Schneier.jpg");
  assert.equal(pickWikidataPerson({ Q1: e.Q1 }, "Bruce Schneier", {}), null);
  assert.equal(pickWikidataPerson({ Q2: e.Q2 }, "Bruce Schneyer", {}), null);
});
