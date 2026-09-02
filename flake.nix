{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];
    in {
      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs
              playwright-driver.browsers
            ];

            shellHook = ''
              export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
              export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true

              # Playwright resolves browsers by REVISION, so a driver that does not match the pinned
              # @playwright/test fails with "Executable doesn't exist at /nix/store/...". That reads as a
              # missing install and sends you to `npx playwright install`, which cannot work here. Say it.
              if [ -f node_modules/playwright-core/package.json ]; then
                pinned=$(node -p "require('./node_modules/playwright-core/package.json').version" 2>/dev/null || echo unknown)
                if [ "$pinned" != "${pkgs.playwright-driver.version}" ]; then
                  echo "osra: playwright $pinned is pinned in node_modules, but these browsers are ${pkgs.playwright-driver.version}."
                  echo "      Launches will fail with 'Executable does not exist'. Either match the versions, or point"
                  echo "      PLAYWRIGHT_BROWSERS_PATH at a directory of symlinks named for the revisions in"
                  echo "      node_modules/playwright-core/browsers.json."
                fi
              fi
            '';
          };
        }
      );
    };
}
