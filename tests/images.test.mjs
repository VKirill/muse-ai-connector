import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractImages, IMAGE_FORMATS, imagePrompt, parseLeadingFormat, saveImages } from "../bridge/images.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "history-image.json"), "utf8"));

test("IMAGE_FORMATS lists the Muse form factors", () => {
  assert.deepEqual(IMAGE_FORMATS, ["1:1", "9:16", "16:9", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "21:9"]);
});

test("imagePrompt prefixes Create image with and without a format", () => {
  assert.equal(imagePrompt("a red fox", "9:16"), "Create image format: 9:16. a red fox");
  assert.equal(imagePrompt("a red fox"), "Create image. a red fox");
  assert.throws(() => imagePrompt("a red fox", "99:1"), /Unknown image format: 99:1/);
});

test("parseLeadingFormat reads a leading token and ignores a trailing one", () => {
  assert.deepEqual(parseLeadingFormat("16:9 лиса в снегу"), { format: "16:9", text: "лиса в снегу" });
  assert.deepEqual(parseLeadingFormat("лиса 16:9"), { format: null, text: "лиса 16:9" });
  assert.deepEqual(parseLeadingFormat("[4:5] cat"), { format: "4:5", text: "cat" });
});

test("extractImages finds the generated webp in the real history fixture", () => {
  const imgs = extractImages(fixture);
  assert.equal(imgs.length, 1);
  assert.equal(
    imgs[0].mediaPath,
    "workspace/imagine_media/media-generation-create-image-format-16-9-a-sma-0-1d534903-e2ba-472d-91d3-3f7f897eb6dd.webp",
  );
  assert.deepEqual([imgs[0].width, imgs[0].height, imgs[0].mime], [2048, 1152, "image/webp"]);
  assert.equal(imgs[0].label, "Small red fox sitting in snow at sunrise");
  assert.equal(extractImages(fixture, { sinceSeq: 1713 }).length, 0);
  assert.equal(extractImages(fixture, { sinceSeq: 1712 }).length, 1);
  const multi = extractImages({
    result: {
      chat_events: [
        {
          seq: 1,
          payload: {
            kind: "image",
            image_path: "workspace/imagine_media/shared.webp",
            data: {
              images: [
                { path: "sandbox://workspace/imagine_media/one.webp", mime: "image/webp", width: 1, height: 1, label: "one" },
                { path: "sandbox://workspace/imagine_media/two.webp", mime: "image/webp", width: 2, height: 2, label: "two" },
              ],
            },
          },
        },
      ],
    },
  });
  assert.equal(multi.length, 2);
  assert.equal(multi[0].mediaPath, "workspace/imagine_media/one.webp");
  assert.equal(multi[1].mediaPath, "workspace/imagine_media/two.webp");
});

test("saveImages writes fetched bytes under the output dir", async () => {
  const dir = fs.mkdtempSync("/tmp/muse-save-images.");
  const mediaPath = "workspace/imagine_media/fox.webp";
  const client = {
    async fetchMedia(p) {
      assert.equal(p, mediaPath);
      return Buffer.from("WEBPBYTES");
    },
  };
  const written = await saveImages(client, [{ mediaPath, mime: "image/webp", width: 2, height: 1, label: "fox" }], dir);
  assert.equal(written.length, 1);
  assert.equal(written[0].path, path.join(dir, "fox.webp"));
  assert.equal(fs.readFileSync(written[0].path).toString(), "WEBPBYTES");
});
