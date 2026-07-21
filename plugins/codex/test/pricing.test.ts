import assert from "node:assert/strict";
import test from "node:test";
import { offeringPriceLabel } from "../web/pricing.js";

test("Codex generation displays model quota instead of a currency price", () => {
  assert.equal(offeringPriceLabel({ mode: "model_quota", currency: "MODEL" }), "模型额度");
});
