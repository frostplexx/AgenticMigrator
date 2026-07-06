{
  description = "pi-container-spike — Node/npm dev shell for the pi rewrite spike";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        # `nix develop ./spike` -> node + npm on PATH for host-side work (npm install,
        # bundling the TS, running run-migration/verify outside Docker). The container
        # build itself only needs Docker; this shell is for iterating on the JS/TS.
        devShells.default = pkgs.mkShell {
          # nodejs_22 bundles npm and npx. esbuild for the eventual TS bundle step.
          packages = with pkgs; [ nodejs_22 esbuild ];
        };
      });
}
