{ inputs, config, pkgs, lib, ... }:

{
  imports = [
    inputs.zotero-selfhost.nixosModules.default
  ];

  networking.hostName = "zotero";

  services.zotero-selfhost = {
    enable = true;
    sopsFile = ./zotero-selfhost.sops.yaml;

    superUser = {
      name = "admin";
      email = "admin@tuckerbradford.com";
    };

    infrastructure = {
      enable = true;
      hostname = "zotero.tuckerbradford.com";
      attachmentsHostname = "attachments.zotero.tuckerbradford.com";
      enableACME = true;
      forceSSL = true;
      openFirewall = true;
    };
  };

  security.acme.acceptTerms = true;
  security.acme.defaults.email = "tucker@tuckerbradford.com";

  # The zotero-selfhost module configures nginx virtualHosts when
  # services.zotero-selfhost.infrastructure.enable = true.

  system.stateVersion = "25.05";
}
