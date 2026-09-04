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

    # Kokoro read-aloud in the web library reader. The URL must be
    # reachable from the host running nginx, not from the browser --
    # nginx proxies it at /reader-tts/ on the SPA's own origin.
    # webLibrary.readerTts = {
    #   enable = true;
    #   kokoroUrl = "http://federalnix.lan:8890";
    #   voice = "af_heart";
    # };

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
