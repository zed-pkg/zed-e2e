# zed-cli PR 516 exact-head certification

This proof binds to `zed-pkg/zed-cli#516` head `2ad562ac322e461cfd6e5938c1b78407f525c2e4`.

It verifies the exact `src/auth.rs` and `src/config.rs` Git blobs, executes the focused locked Rust regression for cached private-read delegation, and asserts that the private-read token resolver does not fall back to the ordinary Supabase/provider token lane.

This is implementation evidence for the CLI half of the Shared Auth ↔ Zed delegation contract already merged in zed-e2e#67. It does not claim product-resource authorization; that remains API-owned.
