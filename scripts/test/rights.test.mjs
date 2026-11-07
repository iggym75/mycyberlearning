// rightsMetadata: expert pictures that carry photographer or copyright details are skipped by the refresh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rightsMetadata } from "../pure.mjs";

// A minimal JPEG with an EXIF IFD0 holding one ASCII tag (0x013B Artist or 0x8298 Copyright).
function jpegWithExif(tag, value, le = true) {
  const v = Buffer.from(value + "\0", "latin1");
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + v.length);
  const w16 = (o, n) => le ? tiff.writeUInt16LE(n, o) : tiff.writeUInt16BE(n, o), w32 = (o, n) => le ? tiff.writeUInt32LE(n, o) : tiff.writeUInt32BE(n, o);
  tiff.write(le ? "II" : "MM", 0, "latin1"); w16(2, 42); w32(4, 8);
  w16(8, 1); w16(10, tag); w16(12, 2); w32(14, v.length); w32(18, v.length <= 4 ? 0 : 26); w32(22, 0);
  v.copy(tiff, 26);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255]), app1, Buffer.alloc(2000), Buffer.from([0xff, 0xd9])]);
}

test("EXIF artist or copyright marks a picture as someone else's work (both byte orders)", () => {
  assert.equal(rightsMetadata(jpegWithExif(0x013b, "Jorge Novominsky")), "EXIF artist");
  assert.equal(rightsMetadata(jpegWithExif(0x8298, "(c) Studio X", false)), "EXIF copyright");
  assert.equal(rightsMetadata(jpegWithExif(0x8298, " ")), null); // empty value
});

test("XMP rights, credits, IPTC by-line and agency names are caught; colour-profile notices aren't", () => {
  const xmp = s => Buffer.from(`\xff\xd8<x:xmpmeta>${s}</x:xmpmeta>` + " ".repeat(2000), "latin1");
  assert.equal(rightsMetadata(xmp('<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">© Scott R. Kline</rdf:li></rdf:Alt></dc:rights>')), "XMP rights");
  assert.equal(rightsMetadata(xmp('photoshop:Credit="Getty Images"')), "mentions Getty Images");
  assert.equal(rightsMetadata(xmp('<photoshop:Credit>SRK Headshot Day</photoshop:Credit>')), "XMP credit");
  const iptc = Buffer.concat([Buffer.from("Photoshop 3.0\x008BIM\x04\x04", "latin1"), Buffer.from([0x1c, 2, 80, 0, 5]), Buffer.from("Alice"), Buffer.alloc(2000)]);
  assert.equal(rightsMetadata(iptc), "IPTC by-line");
  // Every sRGB colour profile says "Copyright (c) 1998 Hewlett-Packard Company": not a rights claim on the picture
  assert.equal(rightsMetadata(Buffer.from("\xff\xd8 ICC_PROFILE text Copyright (c) 1998 Hewlett-Packard Company" + " ".repeat(2000), "latin1")), null);
  assert.equal(rightsMetadata(Buffer.alloc(3000)), null);
});
