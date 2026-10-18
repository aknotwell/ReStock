// The rich link preview for restock.select: Open Graph and Twitter tags on the landing page, and the image.
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webRoutes } from "../src/web/routes.js";

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(webRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("the link preview", () => {
  it("has Open Graph and Twitter card tags with an absolute image URL", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<meta property="og:title" content="Restock">');
    expect(html).toContain('<meta property="og:image" content="https://restock.select/og.png">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<meta name="twitter:image" content="https://restock.select/og.png">');
  });

  it("serves the 1200×630 preview image as a cached PNG", async () => {
    const res = await fetch(`${base}/og.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^image\/png/);
    expect(res.headers.get("cache-control")).toContain("max-age=604800");
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.readUInt32BE(16)).toBe(1200); // IHDR width
    expect(png.readUInt32BE(20)).toBe(630); // IHDR height
  });
});
