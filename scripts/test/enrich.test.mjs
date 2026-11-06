import { test } from "node:test";
import assert from "node:assert/strict";
import { XMLParser } from "fast-xml-parser";
import { inferCadence, parsePodnewsRating, bestMatch, appleId, normaliseIsbn, titlesMatch, canonPublisher, appleArtworkUrl, hasLocalImage, FEED_XML, parsePodnewsSpotify, ogTitle, pickSpotifyShow, sameOrg, imageSize, pickLogo } from "../pure.mjs";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const series = (n, everyDays, endDaysAgo = 1) => Array.from({ length: n }, (_, i) => new Date(NOW - (endDaysAgo + i * everyDays) * 86_400_000).toUTCString());

test("cadence: daily, weekly, fortnightly, monthly", () => {
  assert.equal(inferCadence(series(60, 1), { now: NOW }).freq, "daily");
  assert.equal(inferCadence(series(30, 7), { now: NOW }).freq, "weekly");
  assert.equal(inferCadence(series(20, 14), { now: NOW }).freq, "biweekly");
  assert.equal(inferCadence(series(12, 30), { now: NOW }).freq, "monthly");
  assert.equal(inferCadence(series(40, 2.5), { now: NOW }).freq, "multiweekly");
});

test("cadence: stale shows become irregular, then ended", () => {
  assert.equal(inferCadence(series(30, 7, 200), { now: NOW }).freq, "irregular");
  const ended = inferCadence(series(30, 7, 500), { now: NOW });
  assert.equal(ended.freq, "ended");
  assert.equal(ended.status, "ended");
});

test("cadence: launch date only when the feed is complete", () => {
  const d = series(10, 7);
  assert.match(inferCadence(d, { now: NOW, complete: true }).launched, /^2026-0[89]$/);
  assert.equal(inferCadence(d, { now: NOW, complete: false }).launched, null);
  assert.equal(inferCadence([], { now: NOW }), null);
});

test("podnews rating parser", () => {
  assert.deepEqual(parsePodnewsRating('<p><span>★★★★★</span> 4.8 via 1,852 ratings in Apple Podcasts</p>'), { v: 4.8, n: 1852 });
  assert.deepEqual(parsePodnewsRating("5 via 3 ratings"), { v: 5, n: 3 });
  assert.equal(parsePodnewsRating("no ratings here"), null);
});

test("bestMatch prefers exact, then prefix", () => {
  const res = [{ collectionName: "Darknet Diaries Fan Show" }, { collectionName: "Darknet Diaries" }];
  assert.equal(bestMatch("Darknet Diaries", res).collectionName, "Darknet Diaries");
  assert.equal(bestMatch("The CyberWire Daily", [{ collectionName: "CyberWire Daily" }]).collectionName, "CyberWire Daily");
  assert.equal(bestMatch("Nothing", res), null);
});

test("appleId", () => {
  assert.equal(appleId("https://podcasts.apple.com/podcast/id1296350485"), "1296350485");
  assert.equal(appleId(undefined), null);
});

test("ISBN validation", () => {
  assert.equal(normaliseIsbn("978-1-4920-7621-6"), "9781492076216");
  assert.equal(normaliseIsbn("9781492076217"), null);
  assert.equal(normaliseIsbn("0-306-40615-2"), "0306406152");
  assert.equal(normaliseIsbn("123"), null);
  assert.equal(normaliseIsbn(undefined), null);
});

test("titlesMatch ignores subtitles, editions and leading 'The'", () => {
  assert.ok(titlesMatch("Zero Trust Networks (2nd ed.)", "Zero trust networks: building secure systems in untrusted networks"));
  assert.ok(titlesMatch("The Cybersecurity Manager's Guide", "Cybersecurity Manager's Guide"));
  assert.ok(!titlesMatch("Security as Code", "Learning Cloud Security"));
});

test("publisher names are normalised", () => {
  assert.equal(canonPublisher("Packt Publishing"), "Packt");
  assert.equal(canonPublisher("No Starch Press, Inc."), "No Starch Press");
  assert.equal(canonPublisher("John Wiley & Sons"), "Wiley");
  assert.equal(canonPublisher("O'Reilly Media, Inc."), "O'Reilly Media");
  assert.equal(canonPublisher("Addison-Wesley Professional"), "Addison-Wesley");
  assert.equal(canonPublisher("Bloomsbury Publishing"), "Bloomsbury");
  assert.equal(canonPublisher(undefined), undefined);
});

test("artwork helpers", () => {
  assert.equal(appleArtworkUrl("https://is1-ssl.mzstatic.com/image/thumb/Podcasts1/v4/a/b/c/x.jpg/600x600bb.jpg"),
    "https://is1-ssl.mzstatic.com/image/thumb/Podcasts1/v4/a/b/c/x.jpg/300x300bb.jpg");
  assert.equal(appleArtworkUrl(null), null);
  assert.ok(hasLocalImage({ logo: "covers/podcast-x.jpg" }));
  assert.ok(!hasLocalImage({ logo: "https://example.com/x.jpg" }));
  assert.ok(!hasLocalImage({}));
});

test("feed parser: long HTML show notes parse, entity bombs are still refused", () => {
  const parse = xml => new XMLParser({ ignoreAttributes: true, ...FEED_XML }).parse(xml);
  const notes = "&lt;p&gt;Hacks &amp; leaks&lt;/p&gt;".repeat(800);   // 4000 built-in escapes, like a big real feed
  const doc = parse(`<rss><channel><item><title>Ep 1</title><description>${notes}</description></item></channel></rss>`);
  assert.equal(doc.rss.channel.item.title, "Ep 1");
  assert.ok(doc.rss.channel.item.description.startsWith("<p>Hacks & leaks</p>"));
  // Numeric references are decoded, so a pubDate written with &#43; still parses.
  const d = parse("<rss><channel><item><pubDate>Thu, 29 Oct 2026 00:00:39 &#43;0000</pubDate></item></channel></rss>").rss.channel.item.pubDate;
  assert.equal(new Date(d).toISOString(), "2026-10-29T00:00:39.000Z");
  // Nested "billion laughs" entities are never expanded, and a wide custom entity hits the size limit we keep.
  const lol = Array.from({ length: 6 }, (_, i) => `<!ENTITY l${i + 1} "${`&l${i};`.repeat(10)}">`).join("");
  assert.equal(parse(`<!DOCTYPE rss [<!ENTITY l0 "lol">${lol}]><rss><channel><title>&l6;</title></channel></rss>`).rss.channel.title, "&l6;");
  const wide = `<!DOCTYPE rss [<!ENTITY x "${"A".repeat(9000)}">]><rss><channel><title>${"&x;".repeat(50)}</title></channel></rss>`;
  assert.throws(() => parse(wide), /expanded content size/);
});

test("Spotify link from a Podnews page, and og:title", () => {
  const show = "https://open.spotify.com/show/0KUi5HIbOUJNRD3LTpkWUV";
  assert.equal(parsePodnewsSpotify(`<a href="${show}">Spotify</a> <a href="${show}?si=x">again</a>`), show);
  assert.equal(parsePodnewsSpotify(`<a href="${show}"></a><a href="https://open.spotify.com/show/5ve91nafP42YdcVy2pYUuy"></a>`), null); // two shows: ambiguous
  assert.equal(parsePodnewsSpotify("<p>no links</p>"), null);
  assert.equal(parsePodnewsSpotify(`<a href="https://evil.example/?u=${show}">x</a>`), null);   // embedded in another URL
  assert.equal(ogTitle('<meta property="og:title" content="Beers with Talos Podcast"><title>x</title>'), "Beers with Talos Podcast");
  assert.equal(ogTitle("<title>none</title>"), null);
  assert.equal(ogTitle('<meta property="og:title" content="Paul&#x27;s Security Weekly &amp; Friends">'), "Paul's Security Weekly & Friends");
});

test("Spotify search: name plus publisher or episode count, and look-alikes are told apart", () => {
  const show = (name, publisher, total_episodes, id) => ({ name, publisher, total_episodes, external_urls: { spotify: `https://open.spotify.com/show/${id}?si=abc` } });
  const results = [
    show("Cloud Security Podcast by Google", "Google Cloud", 290, "G"),
    show("Cloud Security Podcast", "Cloud Security Podcast", 330, "C"),
    show("Cloud Security Weekly", "Someone Else", 12, "X")
  ];
  // Two shows start with the name; the exact name with matching episode count wins.
  assert.deepEqual(pickSpotifyShow({ name: "Cloud Security Podcast", by: "Ashish Rajan" }, results, { episodes: 320 }), { url: "https://open.spotify.com/show/C" });
  assert.deepEqual(pickSpotifyShow({ name: "Cloud Security Podcast by Google", by: "Anton Chuvakin · Google Cloud" }, results, {}), { url: "https://open.spotify.com/show/G" });
  // Same name, but neither publisher nor episode count agree: not linked, reported instead.
  const r = pickSpotifyShow({ name: "Beers with Talos", by: "Cisco Talos" }, [show("Beers With Talos", "Some Fan Page", 4, "F")], { episodes: 160, author: "Cisco Talos" });
  assert.ok(!r.url && /Some Fan Page/.test(r.near));
  assert.deepEqual(pickSpotifyShow({ name: "Beers with Talos", by: "Cisco Talos" }, [show("Beers with Talos Podcast", "Cisco Talos Intelligence Group", 158, "T")], {}), { url: "https://open.spotify.com/show/T" });
  assert.equal(pickSpotifyShow({ name: "Darknet Diaries" }, [show("Other", "x", 1, "O")], {}), null);
  assert.ok(sameOrg("N2K Networks", "Dave Bittner · N2K Networks"));
  assert.ok(!sameOrg("Security Weekly Media", "Cyber Security Media"));   // only generic words in common
});

test("image sizes from bytes, and choosing a platform logo", () => {
  const png = Buffer.alloc(33); png.write("\x89PNG\r\n\x1a\n", 0, "latin1"); png.writeUInt32BE(180, 16); png.writeUInt32BE(180, 20);
  assert.deepEqual(imageSize(png), { type: "png", w: 180, h: 180 });
  const gif = Buffer.from("GIF89a", "latin1"); assert.deepEqual(imageSize(Buffer.concat([gif, Buffer.from([0x40, 0x00, 0x20, 0x00]), Buffer.alloc(4)])), { type: "gif", w: 64, h: 32 });
  // JPEG: SOI, an APP0 segment to skip, then SOF0 with height 300 and width 400
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { type: "jpeg", w: 400, h: 300 });
  assert.equal(imageSize(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  // Largest square icon wins; tiny and wide images don't; a square social image is the fallback
  const pick = pickLogo([{ url: "a", from: "icon", w: 32, h: 32 }, { url: "b", from: "icon", w: 180, h: 180 }, { url: "c", from: "icon", w: 256, h: 256 }, { url: "d", from: "og:image", w: 1200, h: 630 }]);
  assert.equal(pick.url, "c");
  assert.equal(pickLogo([{ url: "d", from: "og:image", w: 1200, h: 630 }, { url: "e", from: "icon", w: 48, h: 48 }]), null);
  assert.equal(pickLogo([{ url: "f", from: "og:image", w: 2200, h: 2200 }, { url: "e", from: "icon", w: 48, h: 48 }]).url, "f");
});

test("expert photos: only from their own profiles, best source first; X and LinkedIn never used", async () => {
  const { expertPhotoPlan, bskyThumb, youtubeAvatar } = await import("../pure.mjs");
  const plan = expertPhotoPlan({ bluesky: "https://bsky.app/profile/troyhunt.com", github: "https://github.com/mubix", mastodon: "https://infosec.exchange/@troyhunt",
    youtube: "https://www.youtube.com/@troyhunt", x: "https://x.com/troyhunt", linkedin: "https://www.linkedin.com/in/troyhunt" });
  assert.deepEqual(plan.map(s => s.source), ["Bluesky", "GitHub", "Mastodon", "YouTube"]);
  assert.equal(plan[0].actor, "troyhunt.com");
  assert.equal(plan[1].url, "https://github.com/mubix.png?size=240");
  assert.deepEqual([plan[2].host, plan[2].acct], ["infosec.exchange", "troyhunt"]);
  assert.deepEqual(expertPhotoPlan({ x: "https://x.com/a", linkedin: "https://www.linkedin.com/in/a", web: "https://a.example/" }), []);
  assert.deepEqual(expertPhotoPlan({ bluesky: "https://evil.example/profile/a", github: "https://github.com/a/b" }), []);
  assert.equal(bskyThumb("https://cdn.bsky.app/img/avatar/plain/did:plc:x/abc@jpeg"), "https://cdn.bsky.app/img/avatar_thumbnail/plain/did:plc:x/abc@jpeg");
  assert.equal(youtubeAvatar('<meta property="og:image" content="https://yt3.googleusercontent.com/abc=s900-c-k-c0x00ffffff-no-rj">'), "https://yt3.googleusercontent.com/abc=s240-c-k-c0x00ffffff-no-rj");
  assert.equal(youtubeAvatar('<meta property="og:image" content="https://evil.example/a.jpg">'), null);
});
