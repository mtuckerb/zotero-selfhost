let
  flake = builtins.getFlake (toString ./.);
  system = "x86_64-linux";
  pkgs = import flake.inputs.nixpkgs { inherit system; };
  lib = pkgs.lib;
in
(flake.inputs.nixpkgs.lib.nixosSystem {
  inherit system;
  modules = [
    flake.nixosModules.default
    ({ ... }: {
      system.stateVersion = "25.05";
      services.zotero-selfhost = {
        enable = true;
        sopsFile = ./examples/nixos/zotero-selfhost.sops.example.yaml;
        infrastructure = {
          enable = true;
          hostname = "zotero.tuckerbradford.com";
          attachmentsHostname = "attachments.zotero.tuckerbradford.com";
          enableACME = false;
          forceSSL = false;
        };
      };
    })
  ];
}).config.services.zotero-selfhost.infrastructure.hostname
