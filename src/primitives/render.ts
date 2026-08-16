// Headless-browser rendering. Playwright is an optional dependency: the
// Docker image ships Chromium; a bare local install returns a clear 501-style
// error with the command to enable it.

export interface RenderResult {
  url: string;
  title: string;
  format: "text" | "html";
  content: string;
  truncated: boolean;
}

const CONTENT_CAP = 512 * 1024;

export class RenderUnavailableError extends Error {
  constructor() {
    super(
      "render.extract needs a browser. Install one with: npm install playwright && npx playwright install chromium " +
        "(or run the tollbooth Docker image, which ships Chromium).",
    );
  }
}

export async function extract(
  url: string,
  format: "text" | "html" = "text",
  waitMs = 0,
): Promise<RenderResult> {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new RenderUnavailableError();
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    if (err instanceof Error && err.message.includes("Executable doesn't exist"))
      throw new RenderUnavailableError();
    throw err;
  }
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (waitMs > 0) await page.waitForTimeout(Math.min(waitMs, 10_000));

    const title = await page.title();
    let content: string;
    if (format === "html") {
      content = await page.content();
    } else {
      content = await page.evaluate(() => {
        document.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
        return document.body?.innerText ?? "";
      });
      content = content.replace(/\n{3,}/g, "\n\n").trim();
    }

    const truncated = content.length > CONTENT_CAP;
    return { url, title, format, content: content.slice(0, CONTENT_CAP), truncated };
  } finally {
    await browser.close();
  }
}
