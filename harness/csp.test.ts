import assert from "node:assert/strict";
import test from "node:test";

import { artifactCspIsConstrained } from "./csp.js";

test("accepts a bare sandbox policy serialized before the fleet policy", () => {
  assert.equal(
    artifactCspIsConstrained("sandbox, default-src 'self'; frame-ancestors 'none'"),
    true,
  );
});

test("accepts the service-wide default-src plus frame-ancestors constraint", () => {
  assert.equal(
    artifactCspIsConstrained("default-src 'self'; frame-ancestors 'none'"),
    true,
  );
});

test("accepts semicolon-separated bare sandbox", () => {
  assert.equal(artifactCspIsConstrained("sandbox; default-src 'self'"), true);
});

test("rejects script-enabled sandbox when no fleet constraint is present", () => {
  assert.equal(artifactCspIsConstrained("sandbox allow-scripts; object-src 'none'"), false);
});

test("rejects an embedding-permissive default policy without sandbox", () => {
  assert.equal(
    artifactCspIsConstrained("default-src 'self'; frame-ancestors 'self'"),
    false,
  );
});

test("rejects missing or empty policy values", () => {
  assert.equal(artifactCspIsConstrained(""), false);
  assert.equal(artifactCspIsConstrained(" ; , ; "), false);
});
