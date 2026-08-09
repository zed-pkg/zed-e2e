{
  description = "zed-e2e — environment secrets (ores-sops) for the e2e harness (R2/S3 storage arm)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # The env-secret tooling is org-agnostic and lives in its own repo, so every
    # zed-pkg repo shares one implementation rather than a copied justfile.
    ores-sops.url = "github:ORESoftware/ores-sops";
  };

  outputs = { self, nixpkgs, flake-utils, ores-sops }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ ores-sops.overlays.default ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          name = "zed-e2e";
          packages = with pkgs; [
            # Qualified deliberately: `with pkgs;` does not shadow the outputs
            # function's arguments, so a bare `ores-sops` here resolves to the
            # flake INPUT (an attrset) rather than the package, and nix fails
            # with "Dependency is not of a valid type".
            pkgs.ores-sops
            sops
            age
            just
            git

            # This shell covers env-secret management only. Node, Docker, kind
            # and the browser toolchains for the actual e2e suites are brought
            # by the operator per README prerequisites.
          ];
        };
      });
}
