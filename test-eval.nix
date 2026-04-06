let
  flake = builtins.getFlake (toString /tmp/zotero-selfhost);
  nixpkgs = flake.inputs.nixpkgs;
  system = "x86_64-linux";
  lib = nixpkgs.lib;
  result = lib.nixosSystem {
    inherit system;
    modules = [
      flake.nixosModules.default
      ({ ... }: {
        system.stateVersion = "25.05";
        fileSystems."/" = {
          device = "/dev/disk/by-label/nixos";
          fsType = "ext4";
        };
        services.zotero-selfhost = {
          enable = true;
          sopsFile = ./dummy-secrets.yaml;
        };
      })
    ];
  };
in
{
  serviceNames = builtins.attrNames result.config.systemd.services;
  hasMain = result.config.systemd.services ? zotero-selfhost;
  hasStream = result.config.systemd.services ? zotero-selfhost-stream;
  hasTinymce = result.config.systemd.services ? zotero-selfhost-tinymce;
  secretNames = builtins.attrNames result.config.sops.secrets;
}
