let
  flake = builtins.getFlake (toString ./.);
  system = "x86_64-linux";
  result = flake.inputs.nixpkgs.lib.nixosSystem {
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
            enableACME = false;
            forceSSL = false;
          };
        };
      })
    ];
  };
  cfg = result.config.services.zotero-selfhost;
  host = "attachments-zotero.tuckerbradford.com";
  overridden = (result.extendModules {
    modules = [{ services.zotero-selfhost.infrastructure.attachmentsHostname = "files.example.com"; }];
  }).config;
in
assert cfg.infrastructure.attachmentsHostname == host;
assert cfg.attachmentProxyUrl == "https://${host}";
assert cfg.s3.endpoint == host;
assert result.config.services.nginx.virtualHosts ? ${host};
assert !(result.config.services.nginx.virtualHosts ? "attachments.zotero.tuckerbradford.com");
assert cfg.baseUri == "https://zotero.tuckerbradford.com";
assert overridden.services.zotero-selfhost.s3.endpoint == "files.example.com";
assert overridden.services.zotero-selfhost.attachmentProxyUrl == "https://files.example.com";
assert overridden.services.nginx.virtualHosts ? "files.example.com";
cfg.infrastructure.hostname
