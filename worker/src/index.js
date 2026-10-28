import { Buffer } from "node:buffer";
import dnsPacket from "dns-packet";
import FCM_HOSTS from "./fcm-data.js";

const UPSTREAMS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/dns-query",
];
const TTL = 300;
const MAX_MESSAGE_BYTES = 4096;

function dohResponse(body) {
  return new Response(body, {
    headers: {
      "Content-Type": "application/dns-message",
      "Cache-Control": "no-store",
    },
  });
}

function contentType(headers) {
  return headers.get("content-type")?.split(";")[0].trim().toLowerCase();
}

async function readQuery(request, url) {
  let packet;
  if (request.method === "GET") {
    const value = url.searchParams.get("dns");
    if (
      !value || value.length > Math.ceil(MAX_MESSAGE_BYTES * 4 / 3) ||
      !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1
    ) {
      throw new Error("Invalid DNS GET request");
    }
    packet = Buffer.from(value, "base64url");
    if (packet.toString("base64url") !== value) {
      throw new Error("Invalid base64url encoding");
    }
  } else {
    packet = Buffer.from(await request.arrayBuffer());
  }
  if (packet.length < 12 || packet.length > MAX_MESSAGE_BYTES) {
    throw new Error("Invalid DNS message size");
  }
  return packet;
}

function localAnswer(query, question, records) {
  const values = question.class === "IN" ? records[question.type] || [] : [];
  const answers = values.map((address) => ({
    name: question.name,
    type: question.type,
    class: "IN",
    ttl: TTL,
    data: address,
  }));
  return dohResponse(dnsPacket.encode({
    type: "response",
    id: query.id,
    flags: dnsPacket.AUTHORITATIVE_ANSWER | dnsPacket.RECURSION_AVAILABLE |
      (query.flags & dnsPacket.RECURSION_DESIRED),
    questions: query.questions,
    answers,
  }));
}

async function forwardTo(url, packet, query) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/dns-message",
      Accept: "application/dns-message",
    },
    body: packet,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || contentType(response.headers) !== "application/dns-message") {
    throw new Error("Invalid upstream HTTP response");
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length < 12 || body.length > 65535) {
    throw new Error("Invalid upstream DNS message size");
  }
  const answer = dnsPacket.decode(body);
  const question = answer.questions?.[0];
  if (
    answer.type !== "response" || answer.id !== query.id ||
    answer.questions?.length !== 1 ||
    question.name.toLowerCase() !== query.questions[0].name.toLowerCase() ||
    question.type !== query.questions[0].type ||
    question.class !== query.questions[0].class
  ) {
    throw new Error("Upstream DNS response does not match query");
  }
  return dohResponse(body);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.json({ service: "FCM Static DoH", endpoint: "/dns-query" });
    }
    if (url.pathname !== "/dns-query") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405, headers: { Allow: "GET, POST" },
      });
    }
    if (request.method === "POST" && contentType(request.headers) !== "application/dns-message") {
      return new Response("Unsupported media type", { status: 415 });
    }

    let packet;
    let query;
    try {
      packet = await readQuery(request, url);
      query = dnsPacket.decode(packet);
      if (
        query.type !== "query" || query.opcode !== "QUERY" ||
        query.questions?.length !== 1 || dnsPacket.decode.bytes !== packet.length
      ) {
        throw new Error("Expected one complete DNS query");
      }
    } catch {
      return new Response("Invalid DNS request", { status: 400 });
    }

    const question = query.questions[0];
    const name = question.name.toLowerCase().replace(/\.$/, "");
    if (Object.prototype.hasOwnProperty.call(FCM_HOSTS, name)) {
      return localAnswer(query, question, FCM_HOSTS[name]);
    }
    for (const upstream of UPSTREAMS) {
      try {
        return await forwardTo(upstream, packet, query);
      } catch {
        // Only transport, HTTP, or malformed-response errors try the next resolver.
      }
    }
    return new Response("DNS upstream unavailable", { status: 502 });
  },
};
