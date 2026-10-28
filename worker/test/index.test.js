import assert from "node:assert/strict";
import test from "node:test";
import dnsPacket from "dns-packet";
import worker from "../src/index.js";
import records from "../src/fcm-data.js";

const ENDPOINT = "https://worker.example/dns-query";
const CLOUDFLARE = "https://cloudflare-dns.com/dns-query";
const GOOGLE = "https://dns.google/dns-query";

function query(name = "mtalk.google.com", type = "A", options = {}) {
  return dnsPacket.encode({
    type: "query", id: 1234, flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ name, type, class: "IN" }], ...options,
  });
}

function request(packet, method = "GET") {
  return method === "GET"
    ? new Request(ENDPOINT + "?dns=" + packet.toString("base64url"))
    : new Request(ENDPOINT, {
      method, headers: { "Content-Type": "application/dns-message" }, body: packet,
    });
}

function upstreamResponse(packet, flags = dnsPacket.RECURSION_AVAILABLE) {
  const decoded = dnsPacket.decode(packet);
  return new Response(dnsPacket.encode({
    type: "response", id: decoded.id, flags, questions: decoded.questions,
  }), { headers: { "Content-Type": "application/dns-message" } });
}

for (const method of ["GET", "POST"]) {
  for (const type of ["A", "AAAA"]) {
    test(`${method} ${type} returns local FCM records without an upstream call`, async (context) => {
      const calls = context.mock.method(globalThis, "fetch", () => {
        throw new Error("Local FCM query must not reach an upstream");
      });
      const response = await worker.fetch(request(query("MTALK.GOOGLE.COM", type), method));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/dns-message");
      const decoded = dnsPacket.decode(Buffer.from(await response.arrayBuffer()));
      assert.equal(decoded.type, "response");
      assert.equal(decoded.id, 1234);
      assert.equal(decoded.rcode, "NOERROR");
      assert.deepEqual(decoded.answers.map((answer) => answer.data), records["mtalk.google.com"][type]);
      assert.ok(decoded.answers.every((answer) => answer.ttl === 300));
      assert.equal(calls.mock.callCount(), 0);
    });
  }
}

test("unsupported local query types return NODATA without forwarding", async (context) => {
  const calls = context.mock.method(globalThis, "fetch", () => { throw new Error("unexpected"); });
  const response = await worker.fetch(request(query("mtalk.google.com", "TXT")));
  const decoded = dnsPacket.decode(Buffer.from(await response.arrayBuffer()));
  assert.equal(decoded.rcode, "NOERROR");
  assert.deepEqual(decoded.answers, []);
  assert.equal(calls.mock.callCount(), 0);
});

test("other domains use Cloudflare and preserve the DNS query", async (context) => {
  const packet = query("example.com");
  const calls = context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, CLOUDFLARE);
    assert.equal(options.method, "POST");
    assert.deepEqual(options.body, packet);
    return upstreamResponse(packet);
  });
  assert.equal((await worker.fetch(request(packet))).status, 200);
  assert.equal(calls.mock.callCount(), 1);
});

for (const failure of ["network", "HTTP", "malformed", "mismatched"]) {
  test(`Google handles Cloudflare ${failure} failure`, async (context) => {
    const packet = query("example.com");
    const calls = context.mock.method(globalThis, "fetch", async (url) => {
      if (url === GOOGLE) return upstreamResponse(packet);
      assert.equal(url, CLOUDFLARE);
      if (failure === "network") throw new TypeError("offline");
      if (failure === "HTTP") return new Response("unavailable", { status: 503 });
      if (failure === "mismatched") return upstreamResponse(query("other.example"));
      return new Response("invalid", { headers: { "Content-Type": "application/dns-message" } });
    });
    assert.equal((await worker.fetch(request(packet, "POST"))).status, 200);
    assert.equal(calls.mock.callCount(), 2);
  });
}

test("NXDOMAIN is returned without retrying Google", async (context) => {
  const packet = query("nonexistent.example");
  const calls = context.mock.method(globalThis, "fetch", async () => upstreamResponse(packet, 3));
  const response = await worker.fetch(request(packet));
  const decoded = dnsPacket.decode(Buffer.from(await response.arrayBuffer()));
  assert.equal(decoded.rcode, "NXDOMAIN");
  assert.equal(calls.mock.callCount(), 1);
});

test("both upstreams failing returns 502", async (context) => {
  const calls = context.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  assert.equal((await worker.fetch(request(query("example.com")))).status, 502);
  assert.equal(calls.mock.callCount(), 2);
});

test("malformed requests are rejected before forwarding", async (context) => {
  const calls = context.mock.method(globalThis, "fetch", () => { throw new Error("unexpected"); });
  const invalid = [
    new Request(ENDPOINT),
    new Request(ENDPOINT + "?dns=%%%"),
    request(Buffer.from("short")),
    request(Buffer.alloc(4097), "POST"),
    request(query("example.com", "A", { questions: [] })),
    request(query("example.com", "A", { type: "response" })),
    request(Buffer.concat([query(), Buffer.from([0])])),
  ];
  for (const item of invalid) assert.equal((await worker.fetch(item)).status, 400);
  assert.equal(calls.mock.callCount(), 0);
});

test("unsupported HTTP methods and media types return explicit errors", async () => {
  assert.equal((await worker.fetch(new Request(ENDPOINT, { method: "PUT" }))).status, 405);
  assert.equal((await worker.fetch(new Request(ENDPOINT, { method: "POST", body: "bad" }))).status, 415);
  assert.equal((await worker.fetch(new Request("https://worker.example/missing"))).status, 404);
});
