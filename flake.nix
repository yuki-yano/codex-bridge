{
  description = "codex-bridge development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      # CLI は ChatGPT.app と Computer History に依存するため macOS だけを対象にする。
      system = "aarch64-darwin";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      devShells.${system}.default = pkgs.mkShellNoCC {
        # package.json の packageManager と engines.bun は、flake.lock の nixpkgs が提供する版に合わせる。
        # node は oxlint・oxfmt・tsc の起動スクリプトが使う。
        packages = [
          pkgs.bun
          pkgs.nodejs_24
          pkgs.pnpm_12
        ];
      };
    };
}
